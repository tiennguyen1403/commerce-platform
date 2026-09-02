import { afterAll, afterEach, describe, expect, it } from "vitest";
import { productRepository } from "@/server/repositories/product.repository";
import { VariantInUseError } from "@/server/catalog.errors";
import type { ProductInput } from "@/lib/validators/catalog";
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
