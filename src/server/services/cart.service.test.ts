import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProductStatus } from "@prisma/client";
import { productRepository } from "@/server/repositories/product.repository";
import { cartService } from "@/server/services/cart.service";
import { MAX_CART_QTY, type CartLine } from "@/lib/cart";

/**
 * Unit tests for the cart service — its reconciliation logic in isolation, with
 * the product repository mocked so no DB is touched. The service reads live
 * variant rows and (a) drops lines that aren't purchasable, (b) clamps qty to
 * stock and the hard max, and (c) stamps the store currency onto every line.
 */

vi.mock("@/server/repositories/product.repository", () => ({
  productRepository: { findVariantsForTenant: vi.fn() },
}));

const findVariants = vi.mocked(productRepository.findVariantsForTenant);

// The exact row shape the service consumes (variant + minimal parent product),
// bound to the repository's real return type so a schema drift breaks the build.
type VariantRow = Awaited<
  ReturnType<typeof productRepository.findVariantsForTenant>
>[number];

const TENANT = "tenant_1";

function variantRow(
  o: {
    id?: string;
    name?: string;
    priceCents?: number;
    stock?: number;
    reserved?: number;
    status?: ProductStatus;
    slug?: string;
    title?: string;
    // Primary image the repo returns (`take: 1`). Omit for a product with no
    // images (the common case); `images` then reads as an empty array.
    image?: { url: string; altText: string | null };
  } = {},
): VariantRow {
  const id = o.id ?? "var_1";
  return {
    id,
    productId: "prod_1",
    sku: `SKU-${id}`,
    name: o.name ?? "Default variant",
    providerVariantId: null,
    priceCents: o.priceCents ?? 1000,
    stock: o.stock ?? 10,
    reserved: o.reserved ?? 0,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    product: {
      id: "prod_1",
      title: o.title ?? "Default product",
      slug: o.slug ?? "default-product",
      status: o.status ?? "ACTIVE",
      images: o.image ? [o.image] : [],
    },
  };
}

const line = (variantId: string, qty: number): CartLine => ({ variantId, qty });

beforeEach(() => {
  // Reset (not just clear) so a test that forgets to arm the repo can't inherit
  // a previous test's return value.
  vi.resetAllMocks();
});

describe("cartService.getCartView", () => {
  it("returns an empty cart in the requested currency without hitting the repo", async () => {
    const view = await cartService.getCartView(TENANT, [], "eur");

    expect(view).toEqual({
      items: [],
      totalCents: 0,
      currency: "eur",
      itemCount: 0,
      removedCount: 0,
      adjusted: false,
    });
    expect(findVariants).not.toHaveBeenCalled();
  });

  it("prices lines from live variant data and passes the store currency through", async () => {
    findVariants.mockResolvedValue([
      variantRow({
        id: "v1",
        priceCents: 2500,
        stock: 10,
        title: "Tee",
        name: "Blue",
        slug: "tee",
      }),
    ]);

    const view = await cartService.getCartView(TENANT, [line("v1", 2)], "eur");

    expect(findVariants).toHaveBeenCalledWith(TENANT, ["v1"]);
    expect(view.currency).toBe("eur");
    expect(view.items).toHaveLength(1);
    // Price/title/available come from the DB; qty and currency are the caller's.
    expect(view.items[0]).toMatchObject({
      variantId: "v1",
      productSlug: "tee",
      productTitle: "Tee",
      variantName: "Blue",
      unitPriceCents: 2500,
      currency: "eur",
      qty: 2,
      lineTotalCents: 5000,
      available: 10,
    });
    expect(view.totalCents).toBe(5000);
    expect(view.itemCount).toBe(2);
    expect(view.removedCount).toBe(0);
    expect(view.adjusted).toBe(false);
  });

  it("threads the product's primary image onto the line, or null when it has none", async () => {
    findVariants.mockResolvedValue([
      variantRow({
        id: "withImg",
        image: { url: "/seed/tee.jpg", altText: "A blue tee" },
      }),
      variantRow({ id: "noImg" }),
    ]);

    const view = await cartService.getCartView(
      TENANT,
      [line("withImg", 1), line("noImg", 1)],
      "usd",
    );

    expect(view.items[0].image).toEqual({
      url: "/seed/tee.jpg",
      altText: "A blue tee",
    });
    expect(view.items[1].image).toBeNull();
  });

  it("clamps a line down to available stock and flags the adjustment", async () => {
    findVariants.mockResolvedValue([
      variantRow({ id: "v1", stock: 3, priceCents: 1000 }),
    ]);

    const view = await cartService.getCartView(TENANT, [line("v1", 10)], "usd");

    expect(view.items[0].qty).toBe(3);
    expect(view.items[0].lineTotalCents).toBe(3000);
    expect(view.adjusted).toBe(true);
  });

  it("clamps to sellable stock (stock - reserved), not physical stock", async () => {
    // 10 on hand but 8 held by other in-flight orders → only 2 sellable.
    findVariants.mockResolvedValue([
      variantRow({ id: "v1", stock: 10, reserved: 8, priceCents: 1000 }),
    ]);

    const view = await cartService.getCartView(TENANT, [line("v1", 5)], "usd");

    expect(view.items[0].qty).toBe(2);
    expect(view.items[0].available).toBe(2);
    expect(view.items[0].lineTotalCents).toBe(2000);
    expect(view.adjusted).toBe(true);
  });

  it("drops a line whose units are all reserved (available 0)", async () => {
    findVariants.mockResolvedValue([
      variantRow({ id: "v1", stock: 5, reserved: 5 }),
    ]);

    const view = await cartService.getCartView(TENANT, [line("v1", 1)], "usd");

    expect(view.items).toHaveLength(0);
    expect(view.removedCount).toBe(1);
  });

  it("clamps to MAX_CART_QTY even when stock is higher", async () => {
    findVariants.mockResolvedValue([
      variantRow({ id: "v1", stock: 1000, priceCents: 100 }),
    ]);

    // A qty above the schema max can only reach the service via a tampered
    // cookie; it's defensively clamped to MAX_CART_QTY regardless of stock.
    const view = await cartService.getCartView(
      TENANT,
      [line("v1", 150)],
      "usd",
    );

    expect(view.items[0].qty).toBe(MAX_CART_QTY);
    expect(view.adjusted).toBe(true);
  });

  it("drops unknown, inactive, and out-of-stock lines, counting each removal", async () => {
    findVariants.mockResolvedValue([
      variantRow({ id: "keep", stock: 5, priceCents: 1000 }),
      variantRow({ id: "draft", status: "DRAFT", stock: 5 }),
      variantRow({ id: "archived", status: "ARCHIVED", stock: 5 }),
      variantRow({ id: "empty", stock: 0 }),
      // "missing" is intentionally absent from the repo result (an unknown or
      // foreign id simply doesn't come back).
    ]);

    const view = await cartService.getCartView(
      TENANT,
      [
        line("missing", 1),
        line("keep", 2),
        line("draft", 1),
        line("archived", 1),
        line("empty", 1),
      ],
      "usd",
    );

    expect(view.items.map((item) => item.variantId)).toEqual(["keep"]);
    expect(view.removedCount).toBe(4);
    expect(view.totalCents).toBe(2000);
    expect(view.itemCount).toBe(2);
    expect(view.adjusted).toBe(false);
  });
});

describe("cartService.resolveLine", () => {
  it("returns the requested qty when it fits within stock", async () => {
    findVariants.mockResolvedValue([variantRow({ id: "v1", stock: 5 })]);

    await expect(cartService.resolveLine(TENANT, "v1", 3)).resolves.toEqual({
      ok: true,
      qty: 3,
    });
    expect(findVariants).toHaveBeenCalledWith(TENANT, ["v1"]);
  });

  it("clamps the qty to available stock", async () => {
    findVariants.mockResolvedValue([variantRow({ id: "v1", stock: 5 })]);

    await expect(cartService.resolveLine(TENANT, "v1", 10)).resolves.toEqual({
      ok: true,
      qty: 5,
    });
  });

  it("clamps the qty to sellable stock (stock - reserved)", async () => {
    findVariants.mockResolvedValue([
      variantRow({ id: "v1", stock: 5, reserved: 3 }),
    ]);

    await expect(cartService.resolveLine(TENANT, "v1", 10)).resolves.toEqual({
      ok: true,
      qty: 2,
    });
  });

  it("clamps the qty to MAX_CART_QTY", async () => {
    findVariants.mockResolvedValue([variantRow({ id: "v1", stock: 1000 })]);

    await expect(cartService.resolveLine(TENANT, "v1", 150)).resolves.toEqual({
      ok: true,
      qty: MAX_CART_QTY,
    });
  });

  it("rejects an unknown variant", async () => {
    findVariants.mockResolvedValue([]);

    await expect(cartService.resolveLine(TENANT, "nope", 1)).resolves.toEqual({
      ok: false,
    });
  });

  it("rejects a line whose product isn't ACTIVE", async () => {
    findVariants.mockResolvedValue([
      variantRow({ id: "v1", status: "DRAFT", stock: 5 }),
    ]);

    await expect(cartService.resolveLine(TENANT, "v1", 1)).resolves.toEqual({
      ok: false,
    });
  });

  it("rejects an out-of-stock variant", async () => {
    findVariants.mockResolvedValue([variantRow({ id: "v1", stock: 0 })]);

    await expect(cartService.resolveLine(TENANT, "v1", 1)).resolves.toEqual({
      ok: false,
    });
  });

  it("rejects a variant whose units are all reserved", async () => {
    findVariants.mockResolvedValue([
      variantRow({ id: "v1", stock: 5, reserved: 5 }),
    ]);

    await expect(cartService.resolveLine(TENANT, "v1", 1)).resolves.toEqual({
      ok: false,
    });
  });
});
