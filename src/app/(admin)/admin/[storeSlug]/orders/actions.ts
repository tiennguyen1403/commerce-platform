"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/server/auth/admin-context";
import { InsufficientRoleError } from "@/server/auth/rbac.errors";
import { ROLES } from "@/config/roles";
import {
  orderService,
  OrderNotFoundError,
  OrderTransitionError,
} from "@/server/services/order.service";
import type { OrderActionResult } from "@/lib/validators/orders";
import { reportError } from "@/server/observability/error-reporter";

/**
 * Order lifecycle mutations for the admin detail page. Each action re-resolves
 * the tenant + role from the signed-in session and re-checks the minimum role
 * server-side (`assertRole` — render-time button gating is UX only; Server
 * Actions are public endpoints). Cancel and fulfil are STAFF+; refund is ADMIN+
 * — matching the role split the order service documents. The service owns the
 * atomic guarded transition and the tenant scope; here we only gate, translate
 * errors, and revalidate.
 */

/** Map a thrown error to the client result — the typed lifecycle/RBAC errors to
 *  their message, anything else reported and shown as a generic one. */
async function mapOrderActionError(
  err: unknown,
  action: string,
): Promise<OrderActionResult> {
  // `assertRole` → `requireAdminContext` can `redirect()` (no session) or
  // `notFound()` (unknown store / non-member) — a control-flow throw Next must
  // handle. Re-throw those first so this catch never swallows one into a generic
  // message (or fires the error webhook for a non-error).
  unstable_rethrow(err);

  if (
    err instanceof InsufficientRoleError ||
    err instanceof OrderNotFoundError ||
    err instanceof OrderTransitionError
  ) {
    return { ok: false, error: err.message };
  }

  // An unexpected failure — none of the known domain errors. This action
  // swallows it and returns a friendly message, so Next's onRequestError hook
  // never sees it: report it here at the catch site.
  await reportError(err, { action });
  return { ok: false, error: "Something went wrong. Please try again." };
}

/** Revalidate the order's detail page and the list after a transition. */
function revalidateOrder(storeSlug: string, orderId: string) {
  revalidatePath(`/admin/${storeSlug}/orders`);
  revalidatePath(`/admin/${storeSlug}/orders/${orderId}`);
}

export async function cancelOrderAction(
  storeSlug: string,
  orderId: string,
): Promise<OrderActionResult> {
  try {
    const { tenantId } = await assertRole(storeSlug, ROLES.STAFF);
    if (!orderId) return { ok: false, error: "Missing order." };

    await orderService.cancelOrder(tenantId, orderId);
    revalidateOrder(storeSlug, orderId);
    return { ok: true };
  } catch (err) {
    return mapOrderActionError(err, "order-cancel");
  }
}

export async function fulfillOrderAction(
  storeSlug: string,
  orderId: string,
): Promise<OrderActionResult> {
  try {
    const { tenantId } = await assertRole(storeSlug, ROLES.STAFF);
    if (!orderId) return { ok: false, error: "Missing order." };

    await orderService.fulfillOrder(tenantId, orderId);
    revalidateOrder(storeSlug, orderId);
    return { ok: true };
  } catch (err) {
    return mapOrderActionError(err, "order-fulfill");
  }
}

export async function refundOrderAction(
  storeSlug: string,
  orderId: string,
): Promise<OrderActionResult> {
  try {
    const { tenantId } = await assertRole(storeSlug, ROLES.ADMIN);
    if (!orderId) return { ok: false, error: "Missing order." };

    await orderService.refundOrder(tenantId, orderId);
    revalidateOrder(storeSlug, orderId);
    return { ok: true };
  } catch (err) {
    return mapOrderActionError(err, "order-refund");
  }
}
