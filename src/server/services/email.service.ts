import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { formatMoney } from "@/lib/utils";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { EmailNotConfiguredError } from "@/server/email.errors";
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
 * Email is *optional* config (#39): the client is built lazily so a build — or a
 * webhook for an event we don't email on — never needs a key, and a send with the
 * config unset throws `EmailNotConfiguredError` (a permanent failure) rather than
 * crashing the whole app at boot.
 */

// Re-exported so a caller importing the service also gets the error to catch from
// one module (mirrors `order.service.ts` re-exporting `EmptyCartError`). The class
// itself lives in the dependency-free `email.errors.ts`.
export { EmailNotConfiguredError } from "@/server/email.errors";

let resendSingleton: Resend | null = null;

/** Build the Resend client lazily. The caller has already asserted the key is
 *  present (email config is validated at send time, not at boot — #39). */
function getResend(apiKey: string): Resend {
  resendSingleton ??= new Resend(apiKey);
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

/**
 * Render the order email as a minimal, email-client-safe HTML document (tables +
 * inline styles) with a plain-text alternative for deliverability.
 *
 * The copy adapts to `order.oversold` (#40). A normally-allocated order gets the
 * standard confirmation. An oversold one — the payment was captured, but the
 * atomic stock decrement at PENDING → PAID couldn't fill one or more lines
 * (someone took the last units in the payment window) — must NOT get a
 * reassuring "your order is confirmed / we're getting it ready" message for a
 * line that can't ship. Instead it gets a distinct "we can't fulfil part of this
 * order, a refund is being arranged" message. We only know *that* the order
 * oversold (a durable boolean on the row — the per-line shortfall detail isn't
 * persisted, only logged at capture), so the copy stays order-level and honest
 * rather than naming quantities we can't reconstruct here.
 *
 * Inline hex (not design tokens) is deliberate and matches the existing template:
 * email clients don't support CSS custom properties or external stylesheets.
 */
function renderOrderConfirmation(
  order: OrderWithItems,
  storeName: string,
): RenderedEmail {
  const currency = order.currency;
  const total = formatMoney(order.totalCents, currency);
  const oversold = order.oversold;

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

  const subject = oversold
    ? `Update on your order ${order.orderNumber}`
    : `Order ${order.orderNumber} confirmed`;
  const heading = oversold
    ? "There’s a problem with part of your order"
    : "Thanks for your order";
  const intro = oversold
    ? "Your payment went through, but after checkout we found one or more items are no longer in stock, so we can’t fulfil this order in full. We’ll refund anything we can’t ship — you don’t need to do anything."
    : "Your payment was received and your order is confirmed.";

  // An unmissable callout for the oversold case, above the line items. Muted
  // warm tint (kept AA-legible), not the alarm-red of a hard error.
  const notice = oversold
    ? `
          <div style="margin:0 0 24px;border:1px solid #f0c9c0;background:#fdf3f1;border-radius:8px;padding:14px 16px;">
            <div style="font-weight:600;color:#9a3412;">We can’t fulfil part of this order</div>
            <div style="color:#7c2d12;font-size:13px;margin-top:2px;">Some items sold out between checkout and payment. We’ll refund anything we can’t ship; reply to this email with any questions.</div>
          </div>`
    : "";

  const footer = oversold
    ? `This message was sent to ${escapeHtml(order.email)}. Reply to this email if you have any questions.`
    : `This confirmation was sent to ${escapeHtml(order.email)}. Reply to this email if you have any questions.`;

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f6f6f6;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ececec;border-radius:12px;">
      <tr>
        <td style="padding:32px;">
          <div style="font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;">${escapeHtml(storeName)}</div>
          <h1 style="margin:8px 0 4px;font-size:22px;">${heading}</h1>
          <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">${intro}</p>
${notice}
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

          <p style="margin:32px 0 0;color:#6b7280;font-size:13px;">${footer}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    oversold
      ? `${storeName} — order update`
      : `${storeName} — order confirmation`,
    "",
    intro,
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
    oversold
      ? `This message was sent to ${order.email}.`
      : `This confirmation was sent to ${order.email}.`,
  ].join("\n");

  return { subject, html, text };
}

export const emailService = {
  /**
   * Email a shopper their order confirmation — or, for an oversold order, the
   * distinct "we can't fulfil part of this / a refund is being arranged" message
   * (#40; the copy is chosen from `order.oversold` in `renderOrderConfirmation`).
   * Branded with the tenant's store name (looked up from `order.tenantId`, since
   * the webhook only carries the id), falling back to a neutral label if the
   * tenant can't be resolved.
   * Throws on a Resend failure so the caller can log it; never called on a path
   * where that throw would fail the webhook.
   *
   * `options.idempotencyKey`, when passed (the outbox drain does, #30), rides
   * along as Resend's `Idempotency-Key`: if a send succeeds but the caller then
   * fails to record it (a killed worker) and retries, Resend returns the original
   * result instead of sending a second email (24h window). Retries of a *failed*
   * send are unaffected — the key tracks successes, not failures.
   */
  async sendOrderConfirmation(
    order: OrderWithItems,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    // Email is optional config (#39), validated here at send time rather than at
    // boot. Unset/blank is a *permanent* failure: throw a typed error the webhook
    // swallows (and a retrying caller marks DEAD, never spins on) — checked before
    // any DB or network work so an unconfigured store pays nothing for it.
    const apiKey = env.RESEND_API_KEY;
    const from = env.EMAIL_FROM;
    if (!apiKey || !from) {
      throw new EmailNotConfiguredError();
    }

    const tenant = await tenantRepository.findById(order.tenantId);
    const storeName = tenant?.name ?? "our store";
    const { subject, html, text } = renderOrderConfirmation(order, storeName);

    // Resend reports API-level failures via `error` rather than throwing; turn
    // it into a throw so callers have a single failure channel to handle. The
    // idempotency key (if any) goes in the request options, not the payload.
    const { error } = await getResend(apiKey).emails.send(
      { from, to: order.email, subject, html, text },
      { idempotencyKey: options?.idempotencyKey },
    );
    if (error) {
      throw new Error(
        `Resend failed to send order confirmation (${error.name}): ${error.message}`,
      );
    }
  },
};
