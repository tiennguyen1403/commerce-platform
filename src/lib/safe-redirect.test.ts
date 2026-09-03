import { describe, expect, it } from "vitest";
import { safeInternalPath } from "./safe-redirect";

/**
 * `safeInternalPath` is a security control (open-redirect guard). The
 * control-character cases below are the exact vectors that defeat a naive
 * `startsWith("//")` prefix check — they must return `null`, never a path that
 * re-resolves to another origin.
 */
describe("safeInternalPath", () => {
  it("honors ordinary same-origin paths unchanged", () => {
    expect(safeInternalPath("/admin")).toBe("/admin");
    expect(safeInternalPath("/new")).toBe("/new");
    expect(safeInternalPath("/")).toBe("/");
    expect(safeInternalPath("/admin/acme/products?page=2#top")).toBe(
      "/admin/acme/products?page=2#top",
    );
  });

  it("rejects a missing, empty, or non-path target", () => {
    expect(safeInternalPath(undefined)).toBeNull();
    expect(safeInternalPath(null)).toBeNull();
    expect(safeInternalPath("")).toBeNull();
    expect(safeInternalPath("admin")).toBeNull();
    expect(safeInternalPath("https://evil.com")).toBeNull();
  });

  it("rejects protocol-relative and backslash-smuggled targets", () => {
    expect(safeInternalPath("//evil.com")).toBeNull();
    expect(safeInternalPath("/\\evil.com")).toBeNull();
    expect(safeInternalPath("\\//evil.com")).toBeNull();
  });

  it("rejects control-character open-redirect bypasses (TAB/LF/CR)", () => {
    // The URL parser strips these, so "/\t//evil.com" would otherwise become
    // "///evil.com" → https://evil.com. Each must be refused.
    expect(safeInternalPath("/\t//evil.com")).toBeNull();
    expect(safeInternalPath("/\n//evil.com")).toBeNull();
    expect(safeInternalPath("/\r//evil.com")).toBeNull();
    expect(safeInternalPath("/\t/\\evil.com")).toBeNull();
  });

  it("rejects dot-segment open-redirect bypasses (/..//evil.com)", () => {
    // A leading "/.." normalizes away, leaving the *returned* pathname
    // protocol-relative ("//evil.com") even though the initial parse stayed
    // on-origin — so it re-resolves to https://evil.com at the router. Each
    // must be refused.
    expect(safeInternalPath("/..//evil.com")).toBeNull();
    expect(safeInternalPath("/.//evil.com")).toBeNull();
    expect(safeInternalPath("/a/../..//evil.com")).toBeNull();
    expect(safeInternalPath("/%2e%2e//evil.com")).toBeNull();
    // A dot-segment that resolves to an ordinary same-origin path is still fine.
    expect(safeInternalPath("/admin/../new")).toBe("/new");
  });

  it("never returns a value that resolves to a foreign origin", () => {
    const ORIGIN = "https://store.example.com";
    const probes = [
      "/admin",
      "/new",
      "//evil.com",
      "/\\evil.com",
      "/\t//evil.com",
      "/\n//evil.com",
      "/\r//evil.com",
      "/ /evil.com",
      "/..//evil.com",
      "/.//evil.com",
      "/a/../..//evil.com",
      "/%2e%2e//evil.com",
      "https://evil.com",
    ];
    for (const probe of probes) {
      const safe = safeInternalPath(probe);
      if (safe !== null) {
        // A honored path, resolved the way the router does, stays on our origin.
        expect(new URL(safe, ORIGIN).origin).toBe(ORIGIN);
      }
    }
  });
});
