import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type ProductStatus } from "@prisma/client";
import { productRepository } from "@/server/repositories/product.repository";
import { VariantInUseError } from "@/server/catalog.errors";
import type { ProductInput } from "@/lib/validators/catalog";
import { availableUnits } from "@/lib/inventory";
import {
  createTestTenant,
  deleteTenantDeep,
  prisma,
  uniqueId,
  waitForBlockedLock,
} from "@/test/integration-db";

/**
 * Integration tests for `productRepository.updateWithVariants` against a real
 * Postgres. Two behaviours only the database can prove: the two-phase SKU park
 * that lets an admin swap SKUs between kept variants without tripping
 * `@@unique([productId, sku])` mid-transaction, and the `VariantInUseError`
 * guard over `OrderItem.variant`'s `onDelete: Restrict` — both the in-transaction
 * pre-check and the P2003 backstop for the check-then-delete race.
 */

const tenantIds: string[] = [];
async function freshTenant() {
  const tenant = await createTestTenant();
  tenantIds.push(tenant.id);
  return tenant;
}

afterEach(async () => {
  await Promise.all(tenantIds.splice(0).map(deleteTenantDeep));
});

afterAll(async () => {
  await prisma.$disconnect();
});

type SeedVariant = {
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
};

/** Seed a product with the given variants (ordered by createdAt on read). */
async function seedProduct(
  tenantId: string,
  variants: SeedVariant[],
  overrides: { title?: string } = {},
) {
  return prisma.product.create({
    data: {
      tenantId,
      title: overrides.title ?? "Tee",
      slug: uniqueId("product"),
      status: "ACTIVE",
      variants: { create: variants },
    },
    include: { variants: { orderBy: { createdAt: "asc" } } },
  });
}

/** Build a valid `ProductInput` (the shape the Server Action passes through). */
function productInput(overrides: Partial<ProductInput>): ProductInput {
  return {
    title: "Tee",
    slug: uniqueId("product"),
    status: "ACTIVE",
    variants: [],
    ...overrides,
  };
}

describe("productRepository.updateWithVariants (integration)", () => {
  it("swaps SKUs between two kept variants without tripping the unique constraint", async () => {
    const tenant = await freshTenant();
    const product = await seedProduct(tenant.id, [
      { sku: "SKU-A", name: "A", priceCents: 1000, stock: 5 },
      { sku: "SKU-B", name: "B", priceCents: 2000, stock: 7 },
    ]);
    const a = product.variants.find((v) => v.sku === "SKU-A");
    const b = product.variants.find((v) => v.sku === "SKU-B");
    if (!a || !b) throw new Error("seed produced unexpected variants");

    // Swap the SKUs on the two existing variants. A naive one-pass update would
    // hit @@unique([productId, sku]) the moment A takes B's still-present SKU.
    const updated = await productRepository.updateWithVariants(
      tenant.id,
      product.id,
      productInput({
        slug: product.slug,
        variants: [
          { id: a.id, sku: "SKU-B", name: "A", priceCents: 1000, stock: 5 },
          { id: b.id, sku: "SKU-A", name: "B", priceCents: 2000, stock: 7 },
        ],
      }),
    );
    expect(updated).not.toBeNull();

    const afterSku = new Map(
      (
        await prisma.productVariant.findMany({
          where: { productId: product.id },
        })
      ).map((v) => [v.id, v.sku]),
    );
    expect(afterSku.get(a.id)).toBe("SKU-B");
    expect(afterSku.get(b.id)).toBe("SKU-A");
    // No stray/parked SKUs left behind.
    expect([...afterSku.values()].sort()).toEqual(["SKU-A", "SKU-B"]);
  });

  it("refuses to remove a variant that already appears in an order, naming its SKU", async () => {
    const tenant = await freshTenant();
    const product = await seedProduct(
      tenant.id,
      [
        { sku: "KEEP", name: "Keep", priceCents: 1000, stock: 5 },
        { sku: "USED", name: "Used", priceCents: 1000, stock: 5 },
      ],
      { title: "Original" },
    );
    const keep = product.variants.find((v) => v.sku === "KEEP");
    const used = product.variants.find((v) => v.sku === "USED");
    if (!keep || !used) throw new Error("seed produced unexpected variants");

    // Put USED into an order so it can no longer be deleted.
    await prisma.order.create({
      data: {
        tenantId: tenant.id,
        orderNumber: uniqueId("order"),
        status: "PAID",
        email: "shopper@example.com",
        totalCents: 1000,
        currency: "usd",
        items: {
          create: {
            variantId: used.id,
            titleSnapshot: "Tee / Used",
            priceCents: 1000,
            quantity: 1,
          },
        },
      },
    });

    // An update that drops USED (only KEEP survives) must be refused up front.
    const error = await productRepository
      .updateWithVariants(
        tenant.id,
        product.id,
        productInput({
          title: "Renamed",
          slug: product.slug,
          variants: [
            {
              id: keep.id,
              sku: "KEEP",
              name: "Keep",
              priceCents: 1000,
              stock: 5,
            },
          ],
        }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(VariantInUseError);
    // The pre-check names the offending SKU (not the generic backstop message).
    expect((error as VariantInUseError).message).toContain("USED");

    // The whole transaction rolled back: neither the rename nor the delete stuck.
    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(unchanged.title).toBe("Original");
    expect(await prisma.productVariant.count({ where: { id: used.id } })).toBe(
      1,
    );
  });

  it("maps a delete-time FK restriction (P2003) to VariantInUseError — the race backstop", async () => {
    const tenant = await freshTenant();
    const product = await seedProduct(tenant.id, [
      { sku: "KEEP", name: "Keep", priceCents: 1000, stock: 5 },
      { sku: "DROP", name: "Drop", priceCents: 1000, stock: 5 },
    ]);
    const keep = product.variants.find((v) => v.sku === "KEEP");
    const drop = product.variants.find((v) => v.sku === "DROP");
    if (!keep || !drop) throw new Error("seed produced unexpected variants");

    // An empty order to host the racing order item. DROP has no order items yet,
    // so the in-transaction pre-check will pass — the only way to reach the
    // backstop is to have an order item appear *after* that check but *before*
    // the deleteMany, which is exactly the TOCTOU we reproduce below.
    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        orderNumber: uniqueId("order"),
        status: "PAID",
        email: "shopper@example.com",
        totalCents: 1000,
        currency: "usd",
      },
    });

    // Barrier transaction: lock DROP's row so the update's deleteMany parks on it
    // (which can only happen once its pre-check has already passed), then — once
    // the delete is confirmed blocked — commit an order item onto DROP and
    // release. When the delete resumes it sees the new referencing row and the
    // onDelete:Restrict FK raises P2003.
    let releaseBarrier!: () => void;
    const deleteIsBlocked = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let signalLocked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const barrier = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ProductVariant" WHERE id = ${drop.id} FOR UPDATE`;
        signalLocked();
        await deleteIsBlocked;
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            variantId: drop.id,
            titleSnapshot: "Tee / Drop",
            priceCents: 1000,
            quantity: 1,
          },
        });
        // Returning commits the transaction: releases the lock and publishes the
        // order item to other transactions.
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    await rowLocked;

    // Fire the update that removes DROP. It passes the pre-check, then blocks on
    // the deleteMany behind the barrier's row lock.
    const update = productRepository
      .updateWithVariants(
        tenant.id,
        product.id,
        productInput({
          slug: product.slug,
          variants: [
            {
              id: keep.id,
              sku: "KEEP",
              name: "Keep",
              priceCents: 1000,
              stock: 5,
            },
          ],
        }),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    await waitForBlockedLock();
    releaseBarrier();
    await barrier;

    const error = await update;
    expect(error).toBeInstanceOf(VariantInUseError);
    // The backstop can't know which SKUs — the DB refused, not the pre-check — so
    // it falls back to the generic message.
    expect((error as VariantInUseError).message).toBe(
      "A variant with existing orders can't be removed.",
    );

    // DROP survived (its delete was refused and the whole transaction rolled
    // back); both original variants remain.
    expect(
      await prisma.productVariant.count({ where: { productId: product.id } }),
    ).toBe(2);
  });
});

/**
 * Integration tests for `productRepository.searchActiveByTenant` against a real
 * Postgres — the behaviours only the database can prove: the generated
 * `searchVector` (title weight A over description weight B), tenant + ACTIVE
 * scoping, `ts_rank` ordering, offset pagination, and `websearch_to_tsquery`'s
 * lenience on malformed input.
 */
describe("productRepository.searchActiveByTenant (integration)", () => {
  type SeedFields = {
    title: string;
    description?: string;
    status?: ProductStatus;
    stock?: number;
  };

  /** Seed one searchable product (single variant) with control over the axes the
   *  search filters and ranks on: title, description, status. */
  function seedSearchable(tenantId: string, fields: SeedFields) {
    return prisma.product.create({
      data: {
        tenantId,
        title: fields.title,
        slug: uniqueId("product"),
        description: fields.description ?? null,
        status: fields.status ?? "ACTIVE",
        variants: {
          create: {
            sku: uniqueId("sku"),
            name: "Default",
            priceCents: 1000,
            stock: fields.stock ?? 5,
          },
        },
      },
    });
  }

  const search = (tenantId: string, query: string, page = 1, pageSize = 10) =>
    productRepository.searchActiveByTenant({ tenantId, query, page, pageSize });

  it("returns only the tenant's ACTIVE matches, ranked title-over-description, with variants", async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();

    // Same term in the TITLE (weight A) must outrank it in the DESCRIPTION (B).
    const titleHit = await seedSearchable(tenant.id, {
      title: "Wombat Warmer",
      description: "Cozy fleece for cold nights",
    });
    const descHit = await seedSearchable(tenant.id, {
      title: "Plain Blanket",
      description: "A wombat's winter favourite",
    });
    // Non-ACTIVE matches in the SAME tenant must be excluded.
    await seedSearchable(tenant.id, { title: "Wombat Draft", status: "DRAFT" });
    await seedSearchable(tenant.id, {
      title: "Wombat Archived",
      status: "ARCHIVED",
    });
    // A matching ACTIVE product in ANOTHER tenant must never leak in.
    await seedSearchable(other.id, { title: "Wombat Deluxe" });

    const { products, total } = await search(tenant.id, "wombat");

    expect(total).toBe(2);
    expect(typeof total).toBe("number"); // count(*)::int → JS number, not bigint
    expect(products.map((p) => p.id)).toEqual([titleHit.id, descHit.id]);
    // Variants hydrate, so the caller derives `available = stock - reserved`.
    expect(availableUnits(products[0].variants[0])).toBe(5);
  });

  it("offset-paginates by relevance; total counts every match across pages", async () => {
    const tenant = await freshTenant();
    for (const n of ["one", "two", "three"]) {
      await seedSearchable(tenant.id, { title: `Kangaroo ${n}` });
    }

    // Derive the authoritative rank order from one full page, then assert the
    // offset pages are exact slices of it (stable under the createdAt/id tiebreak).
    const full = await search(tenant.id, "kangaroo", 1, 10);
    expect(full.total).toBe(3);
    const orderedIds = full.products.map((p) => p.id);
    expect(orderedIds).toHaveLength(3);

    const page1 = await search(tenant.id, "kangaroo", 1, 2);
    const page2 = await search(tenant.id, "kangaroo", 2, 2);

    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
    expect(page1.products.map((p) => p.id)).toEqual(orderedIds.slice(0, 2));
    expect(page2.products.map((p) => p.id)).toEqual(orderedIds.slice(2));
    // Pages don't overlap.
    const firstPageIds = new Set(page1.products.map((p) => p.id));
    expect(page2.products.some((p) => firstPageIds.has(p.id))).toBe(false);
  });

  it("tolerates malformed and empty queries without throwing", async () => {
    const tenant = await freshTenant();
    await seedSearchable(tenant.id, { title: "Platypus Paddle" });

    // websearch_to_tsquery reads junk leniently — an empty match, never an error.
    for (const junk of [
      "",
      "   ",
      "!@#$%",
      '"unbalanced',
      "a & | b",
      "foo:*",
    ]) {
      const result = await search(tenant.id, junk);
      expect(result).toEqual({ products: [], total: 0 });
    }

    // A real term still resolves (proves the seed is searchable, not silently 0).
    const hit = await search(tenant.id, "platypus");
    expect(hit.total).toBe(1);
    expect(hit.products[0].title).toBe("Platypus Paddle");
  });
});
