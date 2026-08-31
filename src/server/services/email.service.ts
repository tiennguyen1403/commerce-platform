import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { formatMoney } from "@/lib/utils";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import type { OrderWithItems } from "@/server/repositories/order.repository";

/**
 * Transactional email. M1's only message is the order confirmation, sent from
 * the Stripe webhook's PENDING → PAID transition (not the browser redirect) so
 * it survives the shopper closing the tab and fires exactly once per order.
 *
 * The webhook owns the failure policy: this service lets a send failure surface
 * (a Resend `error` response is turned into a throw) so the caller has a single
 * channel to log. The webhook swallows it and still returns 200 — a Resend
 * outage must never turn a real payment into a retryable webhook failure.
 *
 * Server-only: it holds the Resend secret and is never imported by client code.
 * The client is constructed lazily so a build — or a webhook for an event we
 * don't email on — never needs `RESEND_API_KEY` to be a real key.
 */

let resendSingleton: Resend | null = null;

function getResend(): Resend {
  resendSingleton ??= new Resend(env.RESEND_API_KEY);
  return resendSingleton;
}

/** Escape the HTML-significant characters. Order titles are admin-authored
 *  catalog text, so they're interpolated into the email body as text — never
 *  trusted as markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type RenderedEmail = { subject: string; html: string; text: string };

/** Render the confirmation as a minimal, email-client-safe HTML document (tables
 *  + inline styles) with a plain-text alternative for deliverability. */
function renderOrderConfirmation(
  order: OrderWithItems,
  storeName: string,
): RenderedEmail {
  const currency = order.currency;
  const total = formatMoney(order.totalCents, currency);

  const rows = order.items
    .map((item) => {
      const unit = formatMoney(item.priceCents, currency);
      const lineTotal = formatMoney(item.priceCents * item.quantity, currency);
      return `
            <tr>
              <td style="padding:12px 0;border-bottom:1px solid #ececec;">
                <div style="font-weight:500;">${escapeHtml(item.titleSnapshot)}</div>
                <div style="color:#6b7280;font-size:13px;">Qty ${item.quantity} &times; ${unit}</div>
              </td>
              <td style="padding:12px 0;border-bottom:1px solid #ececec;text-align:right;white-space:nowrap;">${lineTotal}</td>
            </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f6f6f6;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ececec;border-radius:12px;">
      <tr>
        <td style="padding:32px;">
          <div style="font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;">${escapeHtml(storeName)}</div>
          <h1 style="margin:8px 0 4px;font-size:22px;">Thanks for your order</h1>
          <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Your payment was received and your order is confirmed.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:8px;">
            <tr>
              <td style="color:#6b7280;">Order number</td>
              <td style="text-align:right;font-weight:600;">${escapeHtml(order.orderNumber)}</td>
            </tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">${rows}
            <tr>
              <td style="padding:16px 0 0;font-weight:600;">Total</td>
              <td style="padding:16px 0 0;text-align:right;font-weight:700;">${total}</td>
            </tr>
          </table>

          <p style="margin:32px 0 0;color:#6b7280;font-size:13px;">This confirmation was sent to ${escapeHtml(order.email)}. Reply to this email if you have any questions.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `${storeName} — order confirmation`,
    "",
    "Thanks for your order. Your payment was received and your order is confirmed.",
    "",
    `Order number: ${order.orderNumber}`,
    "",
    ...order.items.map(
      (item) =>
        `- ${item.titleSnapshot} (Qty ${item.quantity} x ${formatMoney(item.priceCents, currency)}) = ${formatMoney(item.priceCents * item.quantity, currency)}`,
    ),
    "",
    `Total: ${total}`,
    "",
    `This confirmation was sent to ${order.email}.`,
  ].join("\n");

  return {
    subject: `Order ${order.orderNumber} confirmed`,
    html,
    text,
  };
}

export const emailService = {
  /**
   * Email a shopper their order confirmation. Branded with the tenant's store
   * name (looked up from `order.tenantId`, since the webhook only carries the
   * id), falling back to a neutral label if the tenant can't be resolved.
   * Throws on a Resend failure so the caller can log it; never called on a path
   * where that throw would fail the webhook.
   */
  async sendOrderConfirmation(order: OrderWithItems): Promise<void> {
    const tenant = await tenantRepository.findById(order.tenantId);
    const storeName = tenant?.name ?? "our store";
    const { subject, html, text } = renderOrderConfirmation(order, storeName);

    // Resend reports API-level failures via `error` rather than throwing; turn
    // it into a throw so callers have a single failure channel to handle.
    const { error } = await getResend().emails.send({
      from: env.EMAIL_FROM,
      to: order.email,
      subject,
      html,
      text,
    });
    if (error) {
      throw new Error(
        `Resend failed to send order confirmation (${error.name}): ${error.message}`,
      );
    }
  },
};
