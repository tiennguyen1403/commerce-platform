import { describe, it, expect } from "vitest";
import { buildObjectKey, isSafeObjectKey } from "@/server/storage/object-key";

/**
 * `buildObjectKey` is the single home of the stored object-key shape, and
 * `isSafeObjectKey` is the traversal-free predicate that `imageService.addImage`
 * re-checks a client-echoed key against before it can be stored and later reach
 * `provider.delete(key)`. Both get a direct test: the builder always namespaces by
 * tenant/product and is collision-free, and the predicate refuses every shape that
 * could step out of the `tenants/<tenantId>/…` namespace on any provider.
 */
describe("buildObjectKey", () => {
  it("namespaces the key by tenant + product with the content-type extension", () => {
    const key = buildObjectKey({
      tenantId: "t1",
      productId: "p1",
      contentType: "image/png",
      fileName: "My Photo.PNG",
    });
    expect(key).toMatch(
      /^tenants\/t1\/products\/p1\/[0-9a-f-]{36}-my-photo\.png$/,
    );
  });

  it("mints a unique key per call even for the identical file name", () => {
    const input = {
      tenantId: "t1",
      productId: "p1",
      contentType: "image/jpeg" as const,
      fileName: "same.jpg",
    };
    expect(buildObjectKey(input)).not.toBe(buildObjectKey(input));
  });

  it("always produces a key that passes isSafeObjectKey (the invariant addImage relies on)", () => {
    for (const fileName of [
      "normal.png",
      "../../etc/passwd",
      "a\\b\\c.png",
      "..",
      "   .webp",
      "🙂.jpeg",
    ]) {
      const key = buildObjectKey({
        tenantId: "t1",
        productId: "p1",
        contentType: "image/webp",
        fileName,
      });
      expect(isSafeObjectKey(key)).toBe(true);
    }
  });
});

describe("isSafeObjectKey", () => {
  it("accepts a well-formed, tenant-namespaced key", () => {
    expect(isSafeObjectKey("tenants/t1/products/p1/abc-def-hello.png")).toBe(
      true,
    );
  });

  it.each([
    ["an empty string", ""],
    ["a bare parent-dir segment", ".."],
    ["a single-dot segment", "."],
    ["a leading parent-dir escape", "../secret.png"],
    // The load-bearing case: a PREFIX-VALID key whose interior `..` still names
    // another tenant — what a prefix-only startsWith check would wrongly allow.
    ["a prefix-valid interior traversal", "tenants/t1/../t2/products/p/x.png"],
    ["a trailing parent-dir", "tenants/t1/products/p1/.."],
    ["a backslash separator (Windows)", "tenants\\t1\\x.png"],
    ["an empty interior segment (//)", "tenants/t1//x.png"],
    ["a leading slash (empty first segment)", "/tenants/t1/x.png"],
    ["a NUL byte (truncation trick)", "tenants/t1/a\0.png"],
  ])("refuses %s", (_label, key) => {
    expect(isSafeObjectKey(key)).toBe(false);
  });
});
