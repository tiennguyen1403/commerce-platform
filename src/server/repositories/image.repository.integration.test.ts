import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ProductImage } from "@prisma/client";
import {
  imageRepository,
  type CreateImageInput,
} from "@/server/repositories/image.repository";
import { productRepository } from "@/server/repositories/product.repository";
import {
  createTestTenant,
  deleteTenantDeep,
  prisma,
  uniqueId,
} from "@/test/integration-db";

/**
 * Integration tests for `imageRepository` against a real Postgres. What only the
 * database can prove: the create path appends contiguous `position`s and reads come
 * back in gallery order; reorder rewrites the whole set; delete returns the removed
 * row (its `key` for the object delete); and — the security-critical part — every
 * method is tenant-scoped, so one store can neither read, delete, reorder, nor
 * attach an image to another store's product (the cross-tenant `productId` injection
 * the `product.images` relation include would otherwise expose).
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

/** A bare product to hang images on (variants aren't needed for image tests). */
function seedProduct(tenantId: string) {
  return prisma.product.create({
    data: {
      tenantId,
      title: "Tee",
      slug: uniqueId("product"),
      status: "ACTIVE",
    },
  });
}

/** A valid `CreateImageInput`; `key` is unique by default so rows are distinct. */
function imageInput(
  overrides: Partial<CreateImageInput> = {},
): CreateImageInput {
  const key = overrides.key ?? uniqueId("key");
  return {
    url: overrides.url ?? `/uploads/${key}`,
    key,
    altText: overrides.altText,
    width: overrides.width,
    height: overrides.height,
  };
}

/** Narrow the create/delete result (which is `null` on a tenant miss) for tests
 *  that expect a real row — avoids non-null assertions and gives a clear failure. */
function expectImage(image: ProductImage | null): ProductImage {
  if (!image) throw new Error("expected an image row, got null");
  return image;
}

describe("imageRepository lifecycle (integration)", () => {
  it("appends images with contiguous positions and lists them in gallery order", async () => {
    const tenant = await freshTenant();
    const product = await seedProduct(tenant.id);

    const first = expectImage(
      await imageRepository.createImage(
        tenant.id,
        product.id,
        imageInput({ key: "k/1.png", url: "/u/1.png" }),
      ),
    );
    const second = expectImage(
      await imageRepository.createImage(
        tenant.id,
        product.id,
        imageInput({
          key: "k/2.png",
          url: "/u/2.png",
          altText: "the second",
          width: 800,
          height: 600,
        }),
      ),
    );

    // Positions are the append index; optional fields round-trip.
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
    expect(second.altText).toBe("the second");
    expect(second.width).toBe(800);
    expect(second.height).toBe(600);
    // An omitted optional persists as null.
    expect(first.altText).toBeNull();
    expect(first.width).toBeNull();

    const listed = await imageRepository.listImages(tenant.id, product.id);
    expect(listed.map((image) => image.key)).toEqual(["k/1.png", "k/2.png"]);
    expect(listed.map((image) => image.position)).toEqual([0, 1]);
  });

  it("reorders the whole set and reports the rows moved", async () => {
    const tenant = await freshTenant();
    const product = await seedProduct(tenant.id);
    const a = expectImage(
      await imageRepository.createImage(tenant.id, product.id, imageInput()),
    );
    const b = expectImage(
      await imageRepository.createImage(tenant.id, product.id, imageInput()),
    );
    const c = expectImage(
      await imageRepository.createImage(tenant.id, product.id, imageInput()),
    );

    const moved = await imageRepository.reorderImages(tenant.id, product.id, [
      c.id,
      a.id,
      b.id,
    ]);
    expect(moved).toBe(3);

    const listed = await imageRepository.listImages(tenant.id, product.id);
    expect(listed.map((image) => image.id)).toEqual([c.id, a.id, b.id]);
    expect(listed.map((image) => image.position)).toEqual([0, 1, 2]);
  });

  it("deletes a row, returns it (with key) for the object delete, and no-ops on a foreign id", async () => {
    const tenant = await freshTenant();
    const product = await seedProduct(tenant.id);
    const a = expectImage(
      await imageRepository.createImage(
        tenant.id,
        product.id,
        imageInput({ key: "k/delete-me.png" }),
      ),
    );
    const b = expectImage(
      await imageRepository.createImage(tenant.id, product.id, imageInput()),
    );

    const deleted = expectImage(
      await imageRepository.deleteImage(tenant.id, product.id, a.id),
    );
    // The removed row comes back so the service can delete the object by its key.
    expect(deleted.id).toBe(a.id);
    expect(deleted.key).toBe("k/delete-me.png");

    const remaining = await imageRepository.listImages(tenant.id, product.id);
    expect(remaining.map((image) => image.id)).toEqual([b.id]);

    // An unknown id matches nothing.
    expect(
      await imageRepository.deleteImage(tenant.id, product.id, "ghost"),
    ).toBeNull();
  });

  it("counts images for the owner and returns null for a non-owner", async () => {
    const owner = await freshTenant();
    const other = await freshTenant();
    const product = await seedProduct(owner.id);

    expect(
      await imageRepository.getImageCountForOwnedProduct(owner.id, product.id),
    ).toBe(0);
    await imageRepository.createImage(owner.id, product.id, imageInput());
    expect(
      await imageRepository.getImageCountForOwnedProduct(owner.id, product.id),
    ).toBe(1);

    // Not the owner → null (the sign-time refusal signal), never the count.
    expect(
      await imageRepository.getImageCountForOwnedProduct(other.id, product.id),
    ).toBeNull();
  });
});

describe("product reads return images in gallery order (integration)", () => {
  it("orders each product's images by position across the wired includes", async () => {
    const tenant = await freshTenant();
    const product = await seedProduct(tenant.id);
    const a = expectImage(
      await imageRepository.createImage(
        tenant.id,
        product.id,
        imageInput({ key: "k/a" }),
      ),
    );
    const b = expectImage(
      await imageRepository.createImage(
        tenant.id,
        product.id,
        imageInput({ key: "k/b" }),
      ),
    );
    const c = expectImage(
      await imageRepository.createImage(
        tenant.id,
        product.id,
        imageInput({ key: "k/c" }),
      ),
    );
    // Put the gallery in a non-natural (non-createdAt) order so `orderBy: position`
    // is what's actually being proven, not the insertion order.
    await imageRepository.reorderImages(tenant.id, product.id, [
      c.id,
      a.id,
      b.id,
    ]);
    const expectedOrder = [c.id, a.id, b.id];

    // Every read the issue wired `images` into returns them position-ordered.
    const bySlug = await productRepository.findBySlug(tenant.id, product.slug);
    expect(bySlug?.images.map((image) => image.id)).toEqual(expectedOrder);

    const byId = await productRepository.findByIdForTenant(
      tenant.id,
      product.id,
    );
    expect(byId?.images.map((image) => image.id)).toEqual(expectedOrder);

    const active = await productRepository.listActiveByTenant(tenant.id);
    const listed = active.find((candidate) => candidate.id === product.id);
    expect(listed?.images.map((image) => image.id)).toEqual(expectedOrder);
  });
});

describe("imageRepository tenant isolation (integration)", () => {
  it("createImage refuses to attach to another tenant's product (no row created)", async () => {
    const owner = await freshTenant();
    const intruder = await freshTenant();
    const product = await seedProduct(owner.id);

    const result = await imageRepository.createImage(
      intruder.id,
      product.id,
      imageInput(),
    );
    expect(result).toBeNull();
    // Nothing was written for that product under any tenant — the injection that
    // would leak onto the owner's storefront (the `product.images` include is by
    // productId alone) is closed at the write.
    expect(
      await prisma.productImage.count({ where: { productId: product.id } }),
    ).toBe(0);
  });

  it("never reads, deletes, or reorders another tenant's images", async () => {
    const owner = await freshTenant();
    const intruder = await freshTenant();
    const product = await seedProduct(owner.id);
    const image = expectImage(
      await imageRepository.createImage(owner.id, product.id, imageInput()),
    );

    // The intruder can't see it, count it, delete it, or reorder it.
    expect(await imageRepository.listImages(intruder.id, product.id)).toEqual(
      [],
    );
    expect(
      await imageRepository.getImageCountForOwnedProduct(
        intruder.id,
        product.id,
      ),
    ).toBeNull();
    expect(
      await imageRepository.deleteImage(intruder.id, product.id, image.id),
    ).toBeNull();
    expect(
      await imageRepository.reorderImages(intruder.id, product.id, [image.id]),
    ).toBe(0);

    // The owner's image is entirely untouched.
    const ownerImages = await imageRepository.listImages(owner.id, product.id);
    expect(ownerImages).toHaveLength(1);
    expect(ownerImages[0].id).toBe(image.id);
    expect(ownerImages[0].position).toBe(0);
  });
});
