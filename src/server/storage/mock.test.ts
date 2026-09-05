import { afterAll, describe, it, expect } from "vitest";
import { access, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MockStorageProvider } from "@/server/storage/mock";
import {
  PUBLIC_UPLOADS_DIR,
  resolveLocalUploadPath,
} from "@/server/storage/local-path";

/**
 * The local-disk mock. `getUploadUrl` is asserted on shape (namespaced key + the
 * two derived URLs); `delete` is exercised as a real filesystem round-trip against
 * a per-run tenant subtree, which `afterAll` removes so the suite leaves no bytes
 * behind (`public/uploads/**` is gitignored, but tests still tidy up).
 */
const provider = new MockStorageProvider();

// A unique tenant per run, so a bad assertion can never delete another run's files
// and cleanup can nuke the whole subtree.
const TENANT_ID = `test-tenant-${randomUUID()}`;
const PRODUCT_ID = `test-product-${randomUUID()}`;

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(path.join(PUBLIC_UPLOADS_DIR, "tenants", TENANT_ID), {
    recursive: true,
    force: true,
  });
});

describe("MockStorageProvider.getUploadUrl", () => {
  it("returns a tenant/product-namespaced key with matching sink and public URLs", async () => {
    const result = await provider.getUploadUrl({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      contentType: "image/png",
      fileName: "My Photo.PNG",
    });

    expect(result.key).toMatch(
      new RegExp(`^tenants/${TENANT_ID}/products/${PRODUCT_ID}/`),
    );
    // Extension from the content type; readable slug from the file name.
    expect(result.key.endsWith(".png")).toBe(true);
    expect(result.key).toContain("-my-photo.png");
    // The two URLs are the one key under the two prefixes — the sink writes it,
    // Next serves it static, and delete targets it, all by the same identity.
    expect(result.uploadUrl).toBe(`/api/uploads/local/${result.key}`);
    expect(result.publicUrl).toBe(`/uploads/${result.key}`);
  });

  it("derives the file extension from the content type", async () => {
    const jpeg = await provider.getUploadUrl({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      contentType: "image/jpeg",
      fileName: "a.bin",
    });
    const webp = await provider.getUploadUrl({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      contentType: "image/webp",
      fileName: "a",
    });
    expect(jpeg.key.endsWith(".jpg")).toBe(true);
    expect(webp.key.endsWith(".webp")).toBe(true);
  });

  it("falls back to a neutral `bin` extension for a non-image content type", async () => {
    // Unreachable via the real sign flow (content type is allowlisted upstream);
    // this pins the defensive fallback — never trust the file name for an extension.
    const result = await provider.getUploadUrl({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      contentType: "application/octet-stream",
      fileName: "sneaky.png",
    });
    expect(result.key.endsWith(".bin")).toBe(true);
  });

  it("generates a unique key per call so repeat uploads of one file never collide", async () => {
    const input = {
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      contentType: "image/png",
      fileName: "same.png",
    };
    const a = await provider.getUploadUrl(input);
    const b = await provider.getUploadUrl(input);
    expect(a.key).not.toBe(b.key);
  });
});

describe("MockStorageProvider.delete", () => {
  it("removes an object previously written at the returned key (round-trip)", async () => {
    const { key } = await provider.getUploadUrl({
      tenantId: TENANT_ID,
      productId: PRODUCT_ID,
      contentType: "image/png",
      fileName: "round-trip.png",
    });
    // Simulate the browser's PUT to the sink: bytes land at the key's path.
    const absolutePath = resolveLocalUploadPath(key);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await fileExists(absolutePath)).toBe(true);

    await provider.delete(key);

    expect(await fileExists(absolutePath)).toBe(false);
  });

  it("is best-effort: deleting a key with no file present does not throw", async () => {
    await expect(
      provider.delete(
        `tenants/${TENANT_ID}/products/${PRODUCT_ID}/never-written.png`,
      ),
    ).resolves.toBeUndefined();
  });

  it("is best-effort: an unsafe (traversal) key is swallowed, never throws", async () => {
    await expect(
      provider.delete("tenants/../../../secret.png"),
    ).resolves.toBeUndefined();
  });
});
