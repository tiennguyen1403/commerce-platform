import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProductStatus } from "@prisma/client";
import { productRepository } from "@/server/repositories/product.repository";
import {
  catalogService,
  ProductNotFoundError,
  SlugTakenError,
} from "@/server/services/catalog.service";
import type { ProductInput } from "@/lib/validators/catalog";

/**
 * Unit tests for the catalog service's admin write path, with the product
 * repository mocked. The focus is the business rules the service owns — the
 * friendly slug-uniqueness pre-check (translated to `SlugTakenError`) and the
 * not-found guards — not the repository's own Prisma work.
 */

vi.mock("@/server/repositories/product.repository", () => ({
  productRepository: {
    findBySlug: vi.fn(),
    createWithVariants: vi.fn(),
    updateWithVariants: vi.fn(),
    archive: vi.fn(),
    searchActiveByTenant: vi.fn(),
  },
}));

const findBySlug = vi.mocked(productRepository.findBySlug);
const createWithVariants = vi.mocked(productRepository.createWithVariants);
const updateWithVariants = vi.mocked(productRepository.updateWithVariants);
const archive = vi.mocked(productRepository.archive);
const searchActiveByTenant = vi.mocked(productRepository.searchActiveByTenant);

const TENANT = "tenant_1";

// A full product-with-variants row, bound to the repository's real return type.
type ProductRow = NonNullable<
  Awaited<ReturnType<typeof productRepository.findBySlug>>
>;

function productRow(
  o: { id?: string; slug?: string; status?: ProductStatus } = {},
): ProductRow {
  return {
    id: o.id ?? "prod_1",
    tenantId: TENANT,
    title: "Classic Tee",
    slug: o.slug ?? "classic-tee",
    description: null,
    status: o.status ?? "ACTIVE",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    variants: [],
    // `findBySlug` now includes the gallery images (M5 #186); an image-less
    // product is the empty set, so the fixture carries one to match the type.
    images: [],
  };
}

const input = (o: Partial<ProductInput> = {}): ProductInput => ({
  title: "Classic Tee",
  slug: "classic-tee",
  status: "ACTIVE",
  variants: [{ sku: "TEE-S", name: "Small", priceCents: 1999, stock: 10 }],
  ...o,
});

beforeEach(() => {
  // Reset (not just clear) so a test that forgets to arm the repo can't inherit
  // a previous test's return value.
  vi.resetAllMocks();
});

describe("catalogService.createProduct", () => {
  it("throws SlugTakenError when the slug is already used, without writing", async () => {
    findBySlug.mockResolvedValue(productRow({ id: "existing" }));

    await expect(
      catalogService.createProduct(TENANT, input()),
    ).rejects.toBeInstanceOf(SlugTakenError);
    expect(createWithVariants).not.toHaveBeenCalled();
  });

  it("creates the product when the slug is free", async () => {
    findBySlug.mockResolvedValue(null);
    const created = productRow({ id: "new" });
    createWithVariants.mockResolvedValue(created);
    const data = input();

    await expect(catalogService.createProduct(TENANT, data)).resolves.toBe(
      created,
    );
    expect(findBySlug).toHaveBeenCalledWith(TENANT, "classic-tee");
    expect(createWithVariants).toHaveBeenCalledWith(TENANT, data);
  });
});

describe("catalogService.updateProduct", () => {
  it("throws SlugTakenError when the slug belongs to a different product", async () => {
    findBySlug.mockResolvedValue(productRow({ id: "other" }));

    await expect(
      catalogService.updateProduct(TENANT, "prod_1", input()),
    ).rejects.toBeInstanceOf(SlugTakenError);
    expect(updateWithVariants).not.toHaveBeenCalled();
  });

  it("allows keeping the same slug on the same product", async () => {
    findBySlug.mockResolvedValue(productRow({ id: "prod_1" }));
    const updated = productRow({ id: "prod_1" });
    updateWithVariants.mockResolvedValue(updated);
    const data = input();

    await expect(
      catalogService.updateProduct(TENANT, "prod_1", data),
    ).resolves.toBe(updated);
    expect(updateWithVariants).toHaveBeenCalledWith(TENANT, "prod_1", data);
  });

  it("updates when the slug is free", async () => {
    findBySlug.mockResolvedValue(null);
    const updated = productRow({ id: "prod_1" });
    updateWithVariants.mockResolvedValue(updated);

    await expect(
      catalogService.updateProduct(TENANT, "prod_1", input()),
    ).resolves.toBe(updated);
  });

  it("throws ProductNotFoundError when the product doesn't exist for the tenant", async () => {
    findBySlug.mockResolvedValue(null);
    updateWithVariants.mockResolvedValue(null);

    await expect(
      catalogService.updateProduct(TENANT, "ghost", input()),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
  });
});

describe("catalogService.searchStorefrontProducts", () => {
  it("binds the tenant and passes the search params straight through", async () => {
    const page = { products: [], total: 0 };
    searchActiveByTenant.mockResolvedValue(page);

    await expect(
      catalogService.searchStorefrontProducts(TENANT, {
        query: "classic tee",
        page: 2,
        pageSize: 12,
      }),
    ).resolves.toBe(page);
    expect(searchActiveByTenant).toHaveBeenCalledWith({
      tenantId: TENANT,
      query: "classic tee",
      page: 2,
      pageSize: 12,
    });
  });
});

describe("catalogService.archiveProduct", () => {
  it("resolves when a row was archived", async () => {
    archive.mockResolvedValue(1);

    await expect(
      catalogService.archiveProduct(TENANT, "prod_1"),
    ).resolves.toBeUndefined();
    expect(archive).toHaveBeenCalledWith(TENANT, "prod_1");
  });

  it("throws ProductNotFoundError when nothing was archived", async () => {
    archive.mockResolvedValue(0);

    await expect(
      catalogService.archiveProduct(TENANT, "ghost"),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
  });
});
