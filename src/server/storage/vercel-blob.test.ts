import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The Vercel Blob adapter, with `@vercel/blob` fully mocked (no network, no real
 * HMAC signing) and `@/lib/env` mocked with a mutable token. Under test is the
 * adapter's ORCHESTRATION: the tight per-upload delegation scope it asks for, the
 * `addRandomSuffix: false` presign that keeps the public URL predictable, the
 * store-id → public-URL derivation, delete-by-pathname, and the response-shape +
 * unset-token guards. The real presigned round trip is covered by the documented
 * manual smoke test (`docs/milestones/M5-product-images/vercel-blob-setup.md`),
 * since CI has no token.
 */
vi.mock("@vercel/blob", () => ({
  issueSignedToken: vi.fn(),
  presignUrl: vi.fn(),
  parseStoreIdFromDelegationToken: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@/lib/env", () => ({
  env: { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_store123_secret" },
}));

import {
  del,
  issueSignedToken,
  parseStoreIdFromDelegationToken,
  presignUrl,
} from "@vercel/blob";
import { env } from "@/lib/env";
import { MAX_IMAGE_SIZE_BYTES } from "@/lib/validators/catalog";
import { VercelBlobStorageProvider } from "@/server/storage/vercel-blob";

const issueSignedTokenMock = vi.mocked(issueSignedToken);
const presignUrlMock = vi.mocked(presignUrl);
const parseStoreIdMock = vi.mocked(parseStoreIdFromDelegationToken);
const delMock = vi.mocked(del);

const mockEnv = env as unknown as { BLOB_READ_WRITE_TOKEN?: string };

const TOKEN = "vercel_blob_rw_store123_secret";
const TENANT = "tenant_1";
const PRODUCT = "prod_1";

const uploadInput = (
  o: Partial<{
    tenantId: string;
    productId: string;
    contentType: string;
    fileName: string;
  }> = {},
) => ({
  tenantId: TENANT,
  productId: PRODUCT,
  contentType: "image/png",
  fileName: "My Photo.PNG",
  ...o,
});

/** The control API's canned `issueSignedToken` reply. */
const ISSUED = {
  delegationToken: "deleg.token",
  clientSigningToken: "client-signing-key",
  validUntil: Date.now() + 3_600_000,
};
const PRESIGNED_PUT_URL =
  "https://blob.vercel-storage.com/?pathname=x&vercel-blob-signature=sig";

const provider = new VercelBlobStorageProvider();

beforeEach(() => {
  vi.resetAllMocks();
  mockEnv.BLOB_READ_WRITE_TOKEN = TOKEN;
  issueSignedTokenMock.mockResolvedValue(ISSUED);
  presignUrlMock.mockResolvedValue({ presignedUrl: PRESIGNED_PUT_URL });
  parseStoreIdMock.mockReturnValue("store123");
});

describe("VercelBlobStorageProvider.getUploadUrl", () => {
  it("issues a token scoped to exactly this object and returns the presigned PUT + public URL", async () => {
    const result = await provider.getUploadUrl(
      uploadInput({ contentType: "image/webp", fileName: "hero.webp" }),
    );

    // The key is tenant/product-namespaced (so `addImage`'s `tenants/<tid>/` gate
    // passes) with the extension derived from the content type.
    expect(result.key).toMatch(
      new RegExp(`^tenants/${TENANT}/products/${PRODUCT}/`),
    );
    expect(result.key.endsWith(".webp")).toBe(true);

    // The delegation is scoped to this one pathname, `put` only, this content type
    // and the shared size ceiling — the narrowest possible grant.
    expect(issueSignedTokenMock).toHaveBeenCalledWith({
      token: TOKEN,
      pathname: result.key,
      operations: ["put"],
      allowedContentTypes: ["image/webp"],
      maximumSizeInBytes: MAX_IMAGE_SIZE_BYTES,
      // A hung control-API call is bounded, like the Printful adapter.
      abortSignal: expect.any(AbortSignal),
    });

    // Presigned from the issued material, `addRandomSuffix: false` so the stored
    // pathname stays === our key (what makes the public URL predictable).
    expect(presignUrlMock).toHaveBeenCalledWith(
      {
        delegationToken: ISSUED.delegationToken,
        clientSigningToken: ISSUED.clientSigningToken,
      },
      {
        operation: "put",
        pathname: result.key,
        access: "public",
        addRandomSuffix: false,
        allowedContentTypes: ["image/webp"],
        maximumSizeInBytes: MAX_IMAGE_SIZE_BYTES,
      },
    );

    // The browser PUTs to the presigned control-plane URL; the app renders from the
    // public object host.
    expect(result.uploadUrl).toBe(PRESIGNED_PUT_URL);
    expect(result.publicUrl).toBe(
      `https://store123.public.blob.vercel-storage.com/${result.key}`,
    );
  });

  it("derives the public host's store id from the delegation token, not the raw RW token", async () => {
    parseStoreIdMock.mockReturnValue("otherstore");

    const result = await provider.getUploadUrl(uploadInput());

    expect(parseStoreIdMock).toHaveBeenCalledWith(ISSUED.delegationToken);
    expect(result.publicUrl).toBe(
      `https://otherstore.public.blob.vercel-storage.com/${result.key}`,
    );
  });

  it("mints a unique key per call so repeat uploads of one file never collide", async () => {
    const a = await provider.getUploadUrl(
      uploadInput({ fileName: "same.png" }),
    );
    const b = await provider.getUploadUrl(
      uploadInput({ fileName: "same.png" }),
    );
    expect(a.key).not.toBe(b.key);
  });

  it("rejects a malformed signed-token reply before presigning (response-shape guard)", async () => {
    // An empty `delegationToken` fails the `.min(1)` shape check — external input is
    // validated, not trusted from the SDK's static types.
    issueSignedTokenMock.mockResolvedValue({
      delegationToken: "",
      clientSigningToken: "x",
      validUntil: 1,
    });

    await expect(provider.getUploadUrl(uploadInput())).rejects.toThrow();
    expect(presignUrlMock).not.toHaveBeenCalled();
  });

  it("throws (defense in depth) when the token is unset, before any API call", async () => {
    mockEnv.BLOB_READ_WRITE_TOKEN = undefined;

    await expect(provider.getUploadUrl(uploadInput())).rejects.toThrow(
      /BLOB_READ_WRITE_TOKEN/,
    );
    expect(issueSignedTokenMock).not.toHaveBeenCalled();
  });
});

describe("VercelBlobStorageProvider.delete", () => {
  it("deletes an object by its bare key (pathname), passing the token", async () => {
    delMock.mockResolvedValue(undefined);

    await provider.delete("tenants/t/products/p/abc.png");

    expect(delMock).toHaveBeenCalledWith("tenants/t/products/p/abc.png", {
      token: TOKEN,
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("propagates a delete failure for the calling service to swallow-and-log", async () => {
    // The adapter honours the seam by NOT catching here — `imageService.deleteImage`
    // wraps the call and log-and-continues, so a real failure stays observable.
    delMock.mockRejectedValue(new Error("network down"));

    await expect(
      provider.delete("tenants/t/products/p/abc.png"),
    ).rejects.toThrow("network down");
  });
});

describe("VercelBlobStorageProvider.name", () => {
  it("is `vercel-blob` — the selector's discriminator", () => {
    expect(provider.name).toBe("vercel-blob");
  });
});
