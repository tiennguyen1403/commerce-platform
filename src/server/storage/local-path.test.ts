import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  PUBLIC_UPLOADS_DIR,
  resolveLocalUploadPath,
  UnsafeUploadKeyError,
} from "@/server/storage/local-path";

/**
 * The traversal guard is the security boundary for the file-writing dev sink (the
 * key ultimately comes from a URL path), so it gets a direct test beyond the mock's
 * round-trip: a well-formed key resolves inside the uploads root, and every shape
 * that could escape it is refused.
 */
describe("resolveLocalUploadPath", () => {
  it("resolves a well-formed key to the matching path inside the uploads root", () => {
    const resolved = resolveLocalUploadPath("tenants/t1/products/p1/abc.png");
    expect(resolved).toBe(
      path.join(
        PUBLIC_UPLOADS_DIR,
        "tenants",
        "t1",
        "products",
        "p1",
        "abc.png",
      ),
    );
    // And it genuinely sits under the root (no `..` leftovers).
    const relative = path.relative(PUBLIC_UPLOADS_DIR, resolved);
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
  });

  it("neutralizes a leading slash into a path inside the root (not an escape)", () => {
    // Empty segments are dropped, so "/a/b" is uploads/a/b — safe, not rejected.
    expect(resolveLocalUploadPath("/a/b.png")).toBe(
      path.join(PUBLIC_UPLOADS_DIR, "a", "b.png"),
    );
  });

  it.each([
    ["empty", ""],
    ["only slashes", "///"],
    ["a single dot segment", "."],
    ["a parent-dir segment", ".."],
    ["a leading parent-dir escape", "../secret.png"],
    ["a mid-key parent-dir escape", "tenants/t1/../../../secret.png"],
    ["a backslash separator (Windows)", "tenants\\..\\..\\secret.png"],
    ["a NUL byte (truncation trick)", "tenants/t1/a\0.png"],
  ])("refuses %s", (_label, key) => {
    expect(() => resolveLocalUploadPath(key)).toThrow(UnsafeUploadKeyError);
  });
});
