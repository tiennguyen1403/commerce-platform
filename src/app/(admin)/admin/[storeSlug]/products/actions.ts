"use server";

import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { requireAdminContext } from "@/server/auth/admin-context";
import {
  catalogService,
  DuplicateSkuError,
  ProductNotFoundError,
  SlugTakenError,
  VariantInUseError,
} from "@/server/services/catalog.service";
import {
  productInputSchema,
  type ActionResult,
  type FieldErrors,
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
