import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { access, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Route test for the local-disk upload sink. `@/lib/env` is mocked with a mutable
 * object so a case can flip `NODE_ENV` to production and assert the sink 404s there.
 * Drives the four branches — write, prod-guard, traversal-guard, size-cap — against
 * the real filesystem, cleaning up the per-run tenant subtree afterwards.
 */
vi.mock("@/lib/env", () => ({ env: { NODE_ENV: "test" } }));

import { env } from "@/lib/env";
import { PUT } from "./route";
import {
  PUBLIC_UPLOADS_DIR,
  resolveLocalUploadPath,
} from "@/server/storage/local-path";
import { MAX_IMAGE_SIZE_BYTES } from "@/lib/validators/catalog";

const mockEnv = env as unknown as { NODE_ENV: string };
const TENANT_ID = `test-tenant-${randomUUID()}`;

function context(key: string[]): { params: Promise<{ key: string[] }> } {
  return { params: Promise.resolve({ key }) };
}

function putRequest(body: BodyInit): Request {
  return new Request("https://example.test/api/uploads/local/x", {
    method: "PUT",
    body,
  });
}

async function fileExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  mockEnv.NODE_ENV = "test";
});

afterAll(async () => {
  await rm(path.join(PUBLIC_UPLOADS_DIR, "tenants", TENANT_ID), {
    recursive: true,
    force: true,
  });
});

describe("PUT /api/uploads/local/[...key]", () => {
  it("writes the PUT body under public/uploads and 201s", async () => {
    const key = ["tenants", TENANT_ID, "products", "p1", "abc.png"];
    const response = await PUT(
      putRequest(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      context(key),
    );

    expect(response.status).toBe(201);
    const written = await readFile(resolveLocalUploadPath(key.join("/")));
    expect(Array.from(written)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("404s in production — the sink must not exist on a real deployment", async () => {
    mockEnv.NODE_ENV = "production";
    const key = ["tenants", TENANT_ID, "products", "p1", "prod.png"];

    const response = await PUT(putRequest(new Uint8Array([1])), context(key));

    expect(response.status).toBe(404);
    expect(await fileExists(resolveLocalUploadPath(key.join("/")))).toBe(false);
  });

  it("400s a traversal key without writing anything", async () => {
    const response = await PUT(
      putRequest(new Uint8Array([1])),
      context(["..", "..", "secret.png"]),
    );

    expect(response.status).toBe(400);
  });

  it("400s a non-image extension (a safe path, but nothing served same-origin may be .html)", async () => {
    const key = ["tenants", TENANT_ID, "products", "p1", "evil.html"];

    const response = await PUT(putRequest(new Uint8Array([1])), context(key));

    expect(response.status).toBe(400);
    expect(await fileExists(resolveLocalUploadPath(key.join("/")))).toBe(false);
  });

  it("413s a body over the size cap without writing it", async () => {
    const key = ["tenants", TENANT_ID, "products", "p1", "big.png"];

    const response = await PUT(
      putRequest(new Uint8Array(MAX_IMAGE_SIZE_BYTES + 1)),
      context(key),
    );

    expect(response.status).toBe(413);
    expect(await fileExists(resolveLocalUploadPath(key.join("/")))).toBe(false);
  });
});
