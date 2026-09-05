"use server";

import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import type { ProductImage } from "@prisma/client";
import { requireAdminContext } from "@/server/auth/admin-context";
import {
  catalogService,
  DuplicateSkuError,
  ProductNotFoundError,
  SlugTakenError,
  VariantInUseError,
} from "@/server/services/catalog.service";
import {
  imageService,
  ImageLimitReachedError,
  ImageNotFoundError,
  ImageReorderMismatchError,
  ImageTooLargeError,
  InvalidImageKeyError,
  StorageNotConfiguredError,
  UnsupportedImageTypeError,
} from "@/server/services/image.service";
import {
  addImageSchema,
  imageUploadRequestSchema,
  productInputSchema,
  reorderImagesSchema,
  updateImageAltTextSchema,
  type ActionResult,
  type AddImageResult,
  type FieldErrors,
  type ImageActionError,
  type ImageMutationResult,
  type ProductImageDto,
  type SignUploadResult,
} from "@/lib/validators/catalog";
import { reportError } from "@/server/observability/error-reporter";

/**
 * Catalog mutations. Every action re-resolves the tenant from the signed-in
 * session (`requireAdminContext`) and never trusts a client-supplied tenant,
 * then re-validates the payload with the same zod schema the form uses —
 * Server Actions are public endpoints, so the client-side checks are UX only.
 */

function revalidateCatalog(storeSlug: string, productSlug?: string) {
  // Admin pages are dynamic (they read the session), so this mostly matters for
  // the storefront routes that cache; harmless where a route doesn't exist yet.
  revalidatePath(`/admin/${storeSlug}/products`);
  revalidatePath("/products");
  if (productSlug) revalidatePath(`/products/${productSlug}`);
}

/** Collapse zod issues to first-message-per-top-level-field for the form. */
function fieldErrorsFromZod(error: ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

async function mapWriteError(err: unknown): Promise<ActionResult> {
  if (err instanceof SlugTakenError) {
    return { ok: false, fieldErrors: { slug: err.message } };
  }
  if (err instanceof DuplicateSkuError) {
    return { ok: false, fieldErrors: { variants: err.message } };
  }
  // A removed variant still has orders. It's no longer in the form (the admin
  // deleted its row), so surface it on the variants section, not a single row.
  if (err instanceof VariantInUseError) {
    return { ok: false, fieldErrors: { variants: err.message } };
  }
  if (err instanceof ProductNotFoundError) {
    return { ok: false, formError: err.message };
  }
  // An unexpected write failure — none of the known domain errors above. These
  // actions swallow it and return a friendly message, so Next's onRequestError
  // hook never sees it: report it here at the catch site.
  await reportError(err, { action: "catalog-write" });
  return { ok: false, formError: "Something went wrong. Please try again." };
}

export async function createProductAction(
  storeSlug: string,
  input: unknown,
): Promise<ActionResult> {
  const { tenantId } = await requireAdminContext(storeSlug);

  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
  }

  try {
    const product = await catalogService.createProduct(tenantId, parsed.data);
    revalidateCatalog(storeSlug, product.slug);
    return { ok: true, id: product.id };
  } catch (err) {
    return mapWriteError(err);
  }
}

export async function updateProductAction(
  storeSlug: string,
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const { tenantId } = await requireAdminContext(storeSlug);
  if (!id) return { ok: false, formError: "Missing product id." };

  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
  }

  try {
    const product = await catalogService.updateProduct(
      tenantId,
      id,
      parsed.data,
    );
    revalidateCatalog(storeSlug, product.slug);
    return { ok: true, id: product.id };
  } catch (err) {
    return mapWriteError(err);
  }
}

export async function archiveProductAction(
  storeSlug: string,
  id: string,
): Promise<ActionResult> {
  const { tenantId } = await requireAdminContext(storeSlug);
  if (!id) return { ok: false, formError: "Missing product id." };

  try {
    await catalogService.archiveProduct(tenantId, id);
  } catch (err) {
    return mapWriteError(err);
  }
  revalidateCatalog(storeSlug);
  return { ok: true, id };
}

// --- Product images (#187, M5) -----------------------------------------------
//
// The image manager saves each change immediately through its own action (not on
// the product form's submit): sign → the browser PUTs bytes straight to storage →
// persist the row → reorder / caption / delete. Every action re-resolves the tenant
// from the session and re-parses its payload (the same double-parse posture as the
// product actions), then revalidates the storefront for the product. Bytes never
// pass through a Server Action — only the small `{ url, key, dims }` metadata does.

/** Map an image-service error to the manager's single inline message. The
 *  user-fixable business-rule errors carry a friendly, limit-aware message of
 *  their own, so they're surfaced verbatim; anything else is reported and
 *  generalised (these actions swallow the throw, so `onRequestError` never sees it). */
async function mapImageError(err: unknown): Promise<ImageActionError> {
  // Storage-not-configured is an operator concern (production with no BLOB token);
  // its own message names the env var, which a store admin can neither see
  // meaningfully nor act on. Surface a generic line instead. It's a deterministic
  // config state, not an unexpected fault, so it isn't reported.
  if (err instanceof StorageNotConfiguredError) {
    return { ok: false, error: "Image uploads aren't available right now." };
  }
  if (
    err instanceof UnsupportedImageTypeError ||
    err instanceof ImageTooLargeError ||
    err instanceof ImageLimitReachedError ||
    err instanceof ImageReorderMismatchError ||
    err instanceof ImageNotFoundError ||
    err instanceof InvalidImageKeyError ||
    err instanceof ProductNotFoundError
  ) {
    return { ok: false, error: err.message };
  }
  await reportError(err, { action: "image-write" });
  return { ok: false, error: "Something went wrong. Please try again." };
}

/** Serialize a persisted `ProductImage` for the client (drops timestamps). */
function toImageDto(image: ProductImage): ProductImageDto {
  return {
    id: image.id,
    url: image.url,
    key: image.key,
    altText: image.altText,
    width: image.width,
    height: image.height,
    position: image.position,
  };
}

/**
 * Step 1 of an upload: validate the request and mint a direct-PUT target. Does not
 * mutate, so it doesn't revalidate. Returns `publicUrl`/`key` for the client to
 * echo back to {@link addProductImageAction} once the bytes land.
 */
export async function getImageUploadUrlAction(
  storeSlug: string,
  productId: string,
  input: unknown,
): Promise<SignUploadResult> {
  const { tenantId } = await requireAdminContext(storeSlug);
  if (!productId) return { ok: false, error: "Missing product id." };

  const parsed = imageUploadRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That file can't be uploaded." };
  }

  try {
    const signed = await imageService.requestUpload(
      tenantId,
      productId,
      parsed.data,
    );
    return {
      ok: true,
      uploadUrl: signed.uploadUrl,
      publicUrl: signed.publicUrl,
      key: signed.key,
    };
  } catch (err) {
    return mapImageError(err);
  }
}

/**
 * Step 2 of an upload: persist the image row after the browser's direct PUT
 * succeeded. Returns the created row so the manager renders it without a refetch.
 */
export async function addProductImageAction(
  storeSlug: string,
  productId: string,
  productSlug: string,
  input: unknown,
): Promise<AddImageResult> {
  const { tenantId } = await requireAdminContext(storeSlug);
  if (!productId) return { ok: false, error: "Missing product id." };

  const parsed = addImageSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That image can't be saved." };
  }

  try {
    const image = await imageService.addImage(tenantId, productId, {
      url: parsed.data.url,
      key: parsed.data.key,
      altText: parsed.data.altText,
      width: parsed.data.width,
      height: parsed.data.height,
    });
    revalidateCatalog(storeSlug, productSlug);
    return { ok: true, image: toImageDto(image) };
  } catch (err) {
    return mapImageError(err);
  }
}

/** Set the gallery order to the given full set of image ids. */
export async function reorderProductImagesAction(
  storeSlug: string,
  productId: string,
  productSlug: string,
  input: unknown,
): Promise<ImageMutationResult> {
  const { tenantId } = await requireAdminContext(storeSlug);
  if (!productId) return { ok: false, error: "Missing product id." };

  const parsed = reorderImagesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That reorder is invalid." };
  }

  try {
    await imageService.reorderImages(
      tenantId,
      productId,
      parsed.data.orderedIds,
    );
    revalidateCatalog(storeSlug, productSlug);
    return { ok: true };
  } catch (err) {
    return mapImageError(err);
  }
}

/** Edit one image's alt text (caption). */
export async function updateImageAltTextAction(
  storeSlug: string,
  productId: string,
  productSlug: string,
  input: unknown,
): Promise<ImageMutationResult> {
  const { tenantId } = await requireAdminContext(storeSlug);
  if (!productId) return { ok: false, error: "Missing product id." };

  const parsed = updateImageAltTextSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "That caption can't be saved." };
  }

  try {
    await imageService.updateAltText(
      tenantId,
      productId,
      parsed.data.imageId,
      parsed.data.altText,
    );
    revalidateCatalog(storeSlug, productSlug);
    return { ok: true };
  } catch (err) {
    return mapImageError(err);
  }
}

/** Delete one image (idempotent — an already-gone image is success). */
export async function deleteProductImageAction(
  storeSlug: string,
  productId: string,
  productSlug: string,
  imageId: string,
): Promise<ImageMutationResult> {
  const { tenantId } = await requireAdminContext(storeSlug);
  if (!productId) return { ok: false, error: "Missing product id." };
  if (!imageId) return { ok: false, error: "Missing image id." };

  try {
    await imageService.deleteImage(tenantId, productId, imageId);
    revalidateCatalog(storeSlug, productSlug);
    return { ok: true };
  } catch (err) {
    return mapImageError(err);
  }
}
