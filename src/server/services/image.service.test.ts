import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProductImage } from "@prisma/client";
import { imageRepository } from "@/server/repositories/image.repository";
import { getStorageProvider } from "@/server/storage";
import type { GetUploadUrlInput, GetUploadUrlResult } from "@/server/storage";
import {
  imageService,
  ImageLimitReachedError,
  ImageNotFoundError,
  ImageReorderMismatchError,
  ImageTooLargeError,
  InvalidImageKeyError,
  ProductNotFoundError,
  StorageNotConfiguredError,
  UnsupportedImageTypeError,
} from "@/server/services/image.service";
import {
  MAX_IMAGE_SIZE_BYTES,
  MAX_IMAGES_PER_PRODUCT,
} from "@/lib/validators/catalog";

/**
 * Unit tests for the image service, with the image repository and the storage
 * provider selector both mocked (no DB, no disk). Under test is everything the
 * SERVICE owns: the upload sign guards (content-type allowlist, size cap,
 * not-configured, per-product count cap + ownership), the persist not-found guard,
 * the reorder permutation guard, and the best-effort object delete (row-first, then
 * a swallowed storage failure). The provider selector is mocked at the same seam
 * `fulfillment.service.test.ts` mocks `getFulfillmentProvider`.
 */

vi.mock("@/server/repositories/image.repository", () => ({
  imageRepository: {
    listImages: vi.fn(),
    getImageCountForOwnedProduct: vi.fn(),
    createImage: vi.fn(),
    reorderImages: vi.fn(),
    updateAltText: vi.fn(),
    deleteImage: vi.fn(),
  },
}));
vi.mock("@/server/storage", () => ({ getStorageProvider: vi.fn() }));

const listImages = vi.mocked(imageRepository.listImages);
const getImageCountForOwnedProduct = vi.mocked(
  imageRepository.getImageCountForOwnedProduct,
);
const createImage = vi.mocked(imageRepository.createImage);
const reorderImages = vi.mocked(imageRepository.reorderImages);
const updateAltText = vi.mocked(imageRepository.updateAltText);
const deleteImage = vi.mocked(imageRepository.deleteImage);
const getProvider = vi.mocked(getStorageProvider);

const TENANT = "tenant_1";
const PRODUCT = "prod_1";

/** A fresh mock provider each test (reset by `resetAllMocks` otherwise). Typed
 *  `vi.fn`s so `.mockResolvedValue`/assertions stay type-checked, and the object is
 *  structurally a `StorageProvider` for `getStorageProvider`'s return. */
function makeProvider() {
  return {
    name: "mock" as const,
    getUploadUrl:
      vi.fn<(input: GetUploadUrlInput) => Promise<GetUploadUrlResult>>(),
    delete: vi.fn<(key: string) => Promise<void>>(),
  };
}

/** A ProductImage row fixture bound to the generated model type. */
function imageRow(o: Partial<ProductImage> = {}): ProductImage {
  return {
    id: o.id ?? "img_1",
    tenantId: TENANT,
    productId: PRODUCT,
    url: o.url ?? `/uploads/tenants/${TENANT}/products/${PRODUCT}/abc.png`,
    key: o.key ?? `tenants/${TENANT}/products/${PRODUCT}/abc.png`,
    altText: o.altText ?? null,
    position: o.position ?? 0,
    width: o.width ?? null,
    height: o.height ?? null,
    blurDataUrl: o.blurDataUrl ?? null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  };
}

const uploadInput = (
  o: Partial<Parameters<typeof imageService.requestUpload>[2]> = {},
) => ({
  contentType: "image/png",
  fileName: "photo.png",
  sizeBytes: 1000,
  ...o,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("imageService.requestUpload", () => {
  it("rejects an unsupported content type before touching storage or the DB", async () => {
    await expect(
      imageService.requestUpload(
        TENANT,
        PRODUCT,
        uploadInput({ contentType: "image/gif" }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedImageTypeError);
    expect(getProvider).not.toHaveBeenCalled();
    expect(getImageCountForOwnedProduct).not.toHaveBeenCalled();
  });

  it("rejects a file over the size cap", async () => {
    await expect(
      imageService.requestUpload(
        TENANT,
        PRODUCT,
        uploadInput({ sizeBytes: MAX_IMAGE_SIZE_BYTES + 1 }),
      ),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(getProvider).not.toHaveBeenCalled();
  });

  it("throws StorageNotConfiguredError (fail fast) before any DB read when no provider", async () => {
    getProvider.mockReturnValue(null);

    await expect(
      imageService.requestUpload(TENANT, PRODUCT, uploadInput()),
    ).rejects.toBeInstanceOf(StorageNotConfiguredError);
    expect(getImageCountForOwnedProduct).not.toHaveBeenCalled();
  });

  it("throws ProductNotFoundError when the product isn't the tenant's", async () => {
    const provider = makeProvider();
    getProvider.mockReturnValue(provider);
    getImageCountForOwnedProduct.mockResolvedValue(null);

    await expect(
      imageService.requestUpload(TENANT, PRODUCT, uploadInput()),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
    expect(provider.getUploadUrl).not.toHaveBeenCalled();
  });

  it("throws ImageLimitReachedError when the product is already at the cap", async () => {
    const provider = makeProvider();
    getProvider.mockReturnValue(provider);
    getImageCountForOwnedProduct.mockResolvedValue(MAX_IMAGES_PER_PRODUCT);

    await expect(
      imageService.requestUpload(TENANT, PRODUCT, uploadInput()),
    ).rejects.toBeInstanceOf(ImageLimitReachedError);
    expect(provider.getUploadUrl).not.toHaveBeenCalled();
  });

  it("signs an upload (without the size) when every guard passes", async () => {
    const provider = makeProvider();
    getProvider.mockReturnValue(provider);
    getImageCountForOwnedProduct.mockResolvedValue(MAX_IMAGES_PER_PRODUCT - 1);
    const result = {
      uploadUrl: "/api/uploads/local/tenants/t/products/p/abc.png",
      publicUrl: "/uploads/tenants/t/products/p/abc.png",
      key: "tenants/t/products/p/abc.png",
    };
    provider.getUploadUrl.mockResolvedValue(result);

    await expect(
      imageService.requestUpload(
        TENANT,
        PRODUCT,
        uploadInput({ contentType: "image/webp", fileName: "hero.webp" }),
      ),
    ).resolves.toBe(result);
    expect(provider.getUploadUrl).toHaveBeenCalledWith({
      tenantId: TENANT,
      productId: PRODUCT,
      contentType: "image/webp",
      fileName: "hero.webp",
    });
  });
});

describe("imageService.addImage", () => {
  it("returns the created row on success", async () => {
    const created = imageRow();
    createImage.mockResolvedValue(created);

    await expect(
      imageService.addImage(TENANT, PRODUCT, {
        url: created.url,
        key: created.key,
      }),
    ).resolves.toBe(created);
    expect(createImage).toHaveBeenCalledWith(TENANT, PRODUCT, {
      url: created.url,
      key: created.key,
    });
  });

  it("throws ProductNotFoundError when the product isn't the tenant's", async () => {
    createImage.mockResolvedValue(null);

    await expect(
      imageService.addImage(TENANT, PRODUCT, {
        url: `/uploads/tenants/${TENANT}/products/${PRODUCT}/x.png`,
        key: `tenants/${TENANT}/products/${PRODUCT}/x.png`,
      }),
    ).rejects.toBeInstanceOf(ProductNotFoundError);
  });

  it("rejects a key outside the tenant's namespace before any DB write (cross-tenant delete guard)", async () => {
    // The client echoes the signed `key`; a forged one pointing at another tenant's
    // object (keys are visible in a store's public image URLs) must not be stored,
    // or a later `provider.delete(key)` would cross the tenant boundary.
    await expect(
      imageService.addImage(TENANT, PRODUCT, {
        url: "/uploads/tenants/tenant_2/products/prod_9/x.png",
        key: "tenants/tenant_2/products/prod_9/x.png",
      }),
    ).rejects.toBeInstanceOf(InvalidImageKeyError);
    expect(createImage).not.toHaveBeenCalled();
  });

  it("forwards altText to the repository unmodified — including a blank string (no trim/null normalisation on this path)", async () => {
    // `addImage` does no blank→null normalisation of its own: it forwards whatever
    // the caller passed to the repository (`input.altText ?? null` there maps only
    // `null`/`undefined` → `null`, not `""`). The ACTION path never reaches here
    // with `""` — `addImageSchema` collapses a blank caption to `undefined` at the
    // boundary — so this documents the service's raw contract for a direct caller.
    const created = imageRow({ altText: "" });
    createImage.mockResolvedValue(created);

    await imageService.addImage(TENANT, PRODUCT, {
      url: created.url,
      key: created.key,
      altText: "",
    });

    expect(createImage).toHaveBeenCalledWith(TENANT, PRODUCT, {
      url: created.url,
      key: created.key,
      altText: "",
    });
  });
});

describe("imageService.reorderImages", () => {
  it("reorders when the ids are exactly the product's images", async () => {
    listImages.mockResolvedValue([
      imageRow({ id: "a" }),
      imageRow({ id: "b" }),
      imageRow({ id: "c" }),
    ]);
    reorderImages.mockResolvedValue(3);

    await expect(
      imageService.reorderImages(TENANT, PRODUCT, ["c", "a", "b"]),
    ).resolves.toBeUndefined();
    expect(reorderImages).toHaveBeenCalledWith(TENANT, PRODUCT, [
      "c",
      "a",
      "b",
    ]);
  });

  it("rejects a subset (missing an id) without writing", async () => {
    listImages.mockResolvedValue([
      imageRow({ id: "a" }),
      imageRow({ id: "b" }),
    ]);

    await expect(
      imageService.reorderImages(TENANT, PRODUCT, ["a"]),
    ).rejects.toBeInstanceOf(ImageReorderMismatchError);
    expect(reorderImages).not.toHaveBeenCalled();
  });

  it("rejects a foreign id", async () => {
    listImages.mockResolvedValue([
      imageRow({ id: "a" }),
      imageRow({ id: "b" }),
    ]);

    await expect(
      imageService.reorderImages(TENANT, PRODUCT, ["a", "x"]),
    ).rejects.toBeInstanceOf(ImageReorderMismatchError);
    expect(reorderImages).not.toHaveBeenCalled();
  });

  it("rejects duplicated ids", async () => {
    listImages.mockResolvedValue([
      imageRow({ id: "a" }),
      imageRow({ id: "b" }),
    ]);

    await expect(
      imageService.reorderImages(TENANT, PRODUCT, ["a", "a"]),
    ).rejects.toBeInstanceOf(ImageReorderMismatchError);
    expect(reorderImages).not.toHaveBeenCalled();
  });
});

describe("imageService.updateAltText", () => {
  it("trims the caption and delegates the trimmed value to the repository", async () => {
    updateAltText.mockResolvedValue(true);

    await expect(
      imageService.updateAltText(TENANT, PRODUCT, "img_1", "  A cozy tee  "),
    ).resolves.toBeUndefined();
    expect(updateAltText).toHaveBeenCalledWith(
      TENANT,
      PRODUCT,
      "img_1",
      "A cozy tee",
    );
  });

  it("normalises a whitespace-only caption to null before calling the repository", async () => {
    updateAltText.mockResolvedValue(true);

    await imageService.updateAltText(TENANT, PRODUCT, "img_1", "   ");
    expect(updateAltText).toHaveBeenCalledWith(TENANT, PRODUCT, "img_1", null);
  });

  it("normalises an undefined caption to null before calling the repository", async () => {
    updateAltText.mockResolvedValue(true);

    await imageService.updateAltText(TENANT, PRODUCT, "img_1", undefined);
    expect(updateAltText).toHaveBeenCalledWith(TENANT, PRODUCT, "img_1", null);
  });

  it("throws ImageNotFoundError when the repository matches no row", async () => {
    updateAltText.mockResolvedValue(false);

    await expect(
      imageService.updateAltText(TENANT, PRODUCT, "ghost", "caption"),
    ).rejects.toBeInstanceOf(ImageNotFoundError);
  });
});

describe("imageService.deleteImage", () => {
  it("removes the row then best-effort deletes the object by key", async () => {
    const image = imageRow({ key: "tenants/t/products/p/gone.png" });
    deleteImage.mockResolvedValue(image);
    const provider = makeProvider();
    getProvider.mockReturnValue(provider);
    provider.delete.mockResolvedValue(undefined);

    await expect(
      imageService.deleteImage(TENANT, PRODUCT, image.id),
    ).resolves.toBe(image);
    expect(deleteImage).toHaveBeenCalledWith(TENANT, PRODUCT, image.id);
    expect(provider.delete).toHaveBeenCalledWith(image.key);
  });

  it("swallows a storage delete failure — the row is already gone", async () => {
    const image = imageRow();
    deleteImage.mockResolvedValue(image);
    const provider = makeProvider();
    getProvider.mockReturnValue(provider);
    provider.delete.mockRejectedValue(new Error("network down"));

    // Log-and-continue: a best-effort object delete must never throw the operation.
    await expect(
      imageService.deleteImage(TENANT, PRODUCT, image.id),
    ).resolves.toBe(image);
    expect(provider.delete).toHaveBeenCalledWith(image.key);
  });

  it("is a no-op (returns null) when nothing matched, without calling storage", async () => {
    deleteImage.mockResolvedValue(null);
    const provider = makeProvider();
    getProvider.mockReturnValue(provider);

    await expect(
      imageService.deleteImage(TENANT, PRODUCT, "ghost"),
    ).resolves.toBeNull();
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("removes the row even when storage is unconfigured", async () => {
    const image = imageRow();
    deleteImage.mockResolvedValue(image);
    getProvider.mockReturnValue(null);

    await expect(
      imageService.deleteImage(TENANT, PRODUCT, image.id),
    ).resolves.toBe(image);
  });
});
