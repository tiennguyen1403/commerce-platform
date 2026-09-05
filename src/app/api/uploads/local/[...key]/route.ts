import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { resolveLocalUploadPath } from "@/server/storage/local-path";
import {
  IMAGE_CONTENT_TYPE_EXTENSIONS,
  MAX_IMAGE_SIZE_BYTES,
} from "@/lib/validators/catalog";

// The sink writes into the web-served `public/` tree, so it accepts only image
// extensions — defence in depth beyond the non-prod guard, so even a direct caller
// (not the mock) can't drop a `.html`/executable there to be served same-origin.
// Derived from the shared allowlist→extension map, so it stays in sync with it.
const ALLOWED_UPLOAD_EXTENSIONS = new Set<string>(
  Object.values(IMAGE_CONTENT_TYPE_EXTENSIONS),
);

// Writes the request body to disk and reads dynamic `[...key]` params, so it must
// never be cached or prerendered (reading the request already forces dynamic; this
// makes the intent explicit, mirroring the other write routes). No `runtime`
// export: Node is Next 16's default and the Edge Runtime is deprecated.
export const dynamic = "force-dynamic";

/**
 * Upload sink for the **local-disk storage mock** (M5 #185) — the dev/test analogue
 * of a real provider's presigned-upload target. `MockStorageProvider.getUploadUrl`
 * points its `uploadUrl` here; the browser (or a test) then `PUT`s the raw image
 * bytes, which this writes under `public/uploads/<key>` so Next serves the finished
 * image static at `/uploads/<key>` (the mock's `publicUrl`).
 *
 * Dev/test ONLY. In production, bytes go straight to the real storage provider
 * (Vercel Blob) and this route must not exist — so it 404s there, exactly the way
 * `getStorageProvider` returns `null` (not the mock) in production. Because the key
 * arrives as a URL path (`[...key]`), it is treated as hostile: `resolveLocalUploadPath`
 * refuses any key that could escape the uploads root, only image extensions may be
 * written (so nothing served same-origin can be a `.html`/executable), and the body
 * is size-capped at the same `MAX_IMAGE_SIZE_BYTES` the sign step enforces. All three
 * are defence in depth — a direct caller of the sink, not just the mock, is bound by
 * them.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<NextResponse> {
  if (env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { key } = await params;
  let absolutePath: string;
  try {
    absolutePath = resolveLocalUploadPath(key.join("/"));
  } catch {
    return NextResponse.json({ error: "Invalid upload key" }, { status: 400 });
  }

  const extension = path.extname(absolutePath).slice(1).toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
    return NextResponse.json(
      { error: "Unsupported file extension" },
      { status: 400 },
    );
  }

  // Reject an over-cap upload before buffering it when the client declares its size
  // (App Router route handlers impose no implicit body limit). A missing or
  // understated length can't slip through — the post-read check below is authoritative.
  const declaredLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_IMAGE_SIZE_BYTES
  ) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_IMAGE_SIZE_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body);

  return NextResponse.json({ ok: true }, { status: 201 });
}
