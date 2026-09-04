import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { formatMoney } from "@/lib/utils";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import {
  EmailNotConfiguredError,
  EmailSendTimeoutError,
} from "@/server/email.errors";
import type { OrderWithItems } from "@/server/repositories/order.repository";

/**
 * Transactional email. M1's only message is the order confirmation, sent from
 * the Stripe webhook's PENDING → PAID transition (not the browser redirect) so
 * it survives the shopper closing the tab and fires exactly once per order.
 *
 * The webhook owns the failure policy: this service lets a send failure surface
 * (a Resend `error` response is turned into a throw) so the caller has a single
 * channel to log. A send is also bounded by a timeout (#31) and surfaces the same
 * way, so a hung Resend call can't hold the webhook's response path open. The
 * webhook swallows it and still returns 200 — a Resend outage (or a slow one)
 * must never turn a real payment into a retryable webhook failure.
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
export {
  EmailNotConfiguredError,
  EmailSendTimeoutError,
} from "@/server/email.errors";

let resendSingleton: Resend | null = null;

/** Build the Resend client lazily. The caller has already asserted the key is
 *  present (email config is validated at send time, not at boot — #39). */
function getResend(apiKey: string): Resend {
  resendSingleton ??= new Resend(apiKey);
  return resendSingleton;
}

/**
 * Cap on a single Resend API call. The confirmation send runs on the Stripe
 * webhook's response path (the immediate best-effort dispatch, #30), so a hung
 * Resend call would hold the webhook's 200 open toward Stripe's own delivery
 * timeout — and a late ack provokes a wasteful retry (#31). Resend's SDK offers
 * no per-request timeout or AbortSignal hook (`CreateEmailRequestOptions` is only
 * `query`/`headers`/`idempotencyKey`, and `ResendOptions` takes no custom fetch —
 * verified against resend@6), so we bound the call ourselves. "A few seconds at
 * most" (#31): comfortably above a healthy send yet well under any webhook deadline.
 */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Resolve/reject with `promise`, or reject with `EmailSendTimeoutError` if it
 * hasn't settled within `timeoutMs`. The underlying fetch isn't cancelled — the
 * SDK exposes no handle to abort it — but that's harmless: the webhook only owes
 * Stripe a prompt 200, and a straggling send that *does* land is deduped by the
 * outbox's Resend idempotency key when the retry runs (#30), so giving up early
 * can't double-send. `Promise.race` attaches a reaction to `promise`, so its
 * eventual settlement is consumed (no unhandled rejection); the timer is always
 * cleared, so a healthy send leaves nothing pending on the event loop.
 */
async function withSendTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EmailSendTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Build the shipping-address block as display lines in postal order, skipping any
 * absent field — name / line1 / line2? / "city, state postal" / country. A shipped
 * order always carries a full address (fulfillment required it at submission), but
 * the `ship*` columns are nullable, so this stays defensive: an empty result means
 * "nothing to show" and the caller omits the section. Returns RAW lines; the HTML
 * render escapes each, the text render uses them as-is (the same raw/escaped split
 * `renderOrderConfirmation` applies to order titles).
 */
function shippingAddressLines(order: OrderWithItems): string[] {
  const cityRegion = [order.shipCity, order.shipState]
    .map((v) => v?.trim())
    .filter((v): v is string => !!v)
    .join(", ");
  const cityLine = [cityRegion, order.shipPostalCode?.trim()]
    .filter((v): v is string => !!v)
    .join(" ");
  return [
    order.shipName,
    order.shipLine1,
    order.shipLine2,
    cityLine,
    order.shipCountry,
  ]
    .map((v) => v?.trim() ?? "")
    .filter((v) => v.length > 0);
}

/**
 * Render the shipping-confirmation email (M4-08 / #141) — the "your order has
 * shipped" notification the poll-fulfillment reconcile enqueues once a provider
 * reports a shipment. Mirrors `renderOrderConfirmation`'s email-client-safe shape
 * (a max-width table, inline hex — email clients honour neither CSS custom
 * properties nor external stylesheets — and a plain-text alternative) and its
 * escaping discipline: every value the shopper didn't author — the store name,
 * order titles, the shipping address, and the provider-supplied carrier + tracking
 * — is escaped into the HTML body as text, never trusted as markup (the tracking
 * URL is escaped for its `href` too).
 *
 * The `tracking*` columns are nullable, but a `SHIPPING_CONFIRMATION` is only ever
 * enqueued right after `markShipped` persists a real tracking NUMBER (the poll's
 * provider-agnostic "shipped" signal), so a number is present in practice; the
 * carrier and URL may still be absent (a shipment can carry a number but no carrier
 * or link). The "Track your shipment" link renders only for an http(s) URL, so a
 * missing or non-web value degrades to carrier + number as text rather than an odd
 * or unsafe `href`.
 */
function renderShippingConfirmation(
  order: OrderWithItems,
  storeName: string,
): RenderedEmail {
  const rows = order.items
    .map(
      (item) => `
            <tr>
              <td style="padding:12px 0;border-bottom:1px solid #ececec;font-weight:500;">${escapeHtml(item.titleSnapshot)}</td>
              <td style="padding:12px 0;border-bottom:1px solid #ececec;text-align:right;white-space:nowrap;color:#6b7280;">Qty ${item.quantity}</td>
            </tr>`,
    )
    .join("");

  const subject = `Your order ${order.orderNumber} has shipped`;

  // A tracking link renders only for a web URL; carrier + number always show as
  // text. The URL comes from the provider (server-side), but is still escaped for
  // the `href` — and gated to http(s) — so a garbage value can't break the attribute.
  const trackingUrl =
    order.trackingUrl && /^https?:\/\//i.test(order.trackingUrl)
      ? order.trackingUrl
      : null;

  const trackingRows = [
    order.trackingCarrier
      ? `
            <tr>
              <td style="color:#6b7280;">Carrier</td>
              <td style="text-align:right;font-weight:600;">${escapeHtml(order.trackingCarrier)}</td>
            </tr>`
      : "",
    order.trackingNumber
      ? `
            <tr>
              <td style="color:#6b7280;">Tracking number</td>
              <td style="text-align:right;font-weight:600;">${escapeHtml(order.trackingNumber)}</td>
            </tr>`
      : "",
  ].join("");

  const trackButton = trackingUrl
    ? `
          <a href="${escapeHtml(trackingUrl)}" style="display:inline-block;margin:20px 0 0;padding:12px 22px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Track your shipment</a>`
    : "";

  const addressLines = shippingAddressLines(order);
  const address =
    addressLines.length > 0
      ? `
          <h2 style="margin:32px 0 8px;font-size:14px;">Shipping to</h2>
          <p style="margin:0;color:#374151;font-size:14px;line-height:1.5;">${addressLines
            .map(escapeHtml)
            .join("<br />")}</p>`
      : "";

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f6f6f6;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #ececec;border-radius:12px;">
      <tr>
        <td style="padding:32px;">
          <div style="font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;">${escapeHtml(storeName)}</div>
          <h1 style="margin:8px 0 4px;font-size:22px;">Your order is on its way</h1>
          <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">Good news — your order has shipped. Use the tracking details below to follow its journey.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:8px;">
            <tr>
              <td style="color:#6b7280;">Order number</td>
              <td style="text-align:right;font-weight:600;">${escapeHtml(order.orderNumber)}</td>
            </tr>${trackingRows}
          </table>${trackButton}

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:24px;">${rows}
          </table>${address}

          <p style="margin:32px 0 0;color:#6b7280;font-size:13px;">This notification was sent to ${escapeHtml(order.email)}. Reply to this email if you have any questions.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `${storeName} — your order has shipped`,
    "",
    "Good news — your order has shipped.",
    "",
    `Order number: ${order.orderNumber}`,
    ...(order.trackingCarrier ? [`Carrier: ${order.trackingCarrier}`] : []),
    ...(order.trackingNumber
      ? [`Tracking number: ${order.trackingNumber}`]
      : []),
    ...(trackingUrl ? [`Track your shipment: ${trackingUrl}`] : []),
    "",
    "Items:",
    ...order.items.map(
      (item) => `- ${item.titleSnapshot} (Qty ${item.quantity})`,
    ),
    ...(addressLines.length > 0 ? ["", "Shipping to:", ...addressLines] : []),
    "",
    `This notification was sent to ${order.email}.`,
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
   * Throws on a Resend failure — or `EmailSendTimeoutError` if the send exceeds
   * `SEND_TIMEOUT_MS` (#31) — so the caller can log/classify it; never called on
   * a path where that throw would fail the webhook.
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
    // The call is bounded by `withSendTimeout` (#31) so a hung send can't hold
    // the webhook's response path open; a timeout surfaces as a throw like any
    // other failure and the outbox (#30) retries it.
    const { error } = await withSendTimeout(
      getResend(apiKey).emails.send(
        { from, to: order.email, subject, html, text },
        { idempotencyKey: options?.idempotencyKey },
      ),
      SEND_TIMEOUT_MS,
    );
    if (error) {
      throw new Error(
        `Resend failed to send order confirmation (${error.name}): ${error.message}`,
      );
    }
  },

  /**
   * Email a shopper that their order has shipped — with the carrier + a tracking
   * link and the shipping address (#141). The poll-fulfillment reconcile (M4 #140)
   * enqueues it, and the outbox drain delivers it through the SAME path as the
   * confirmation, so it shares that path's failure policy: an unset/blank Resend
   * config throws the permanent `EmailNotConfiguredError` (the drain marks it DEAD,
   * never spins on it), and a Resend API error — or an `EmailSendTimeoutError` if
   * the send exceeds `SEND_TIMEOUT_MS` (#31) — surfaces as a throw the drain
   * retries with backoff. Branded with the tenant's store name (looked up from
   * `order.tenantId`), falling back to a neutral label if the tenant can't be
   * resolved.
   *
   * `options.idempotencyKey` (the drain passes `sc_<orderId>`) rides along as
   * Resend's `Idempotency-Key`, so a send that succeeds but whose row update is
   * then lost to a killed worker is deduped on the re-drain instead of sending a
   * second email (24h window).
   */
  async sendShippingConfirmation(
    order: OrderWithItems,
    options?: { idempotencyKey?: string },
  ): Promise<void> {
    // Same send-time config gate as the confirmation: unset/blank is a permanent
    // failure, checked before any DB or network work.
    const apiKey = env.RESEND_API_KEY;
    const from = env.EMAIL_FROM;
    if (!apiKey || !from) {
      throw new EmailNotConfiguredError();
    }

    const tenant = await tenantRepository.findById(order.tenantId);
    const storeName = tenant?.name ?? "our store";
    const { subject, html, text } = renderShippingConfirmation(
      order,
      storeName,
    );

    // Resend reports API failures via `error`, not a throw — turn it into a throw
    // so callers have one failure channel. Bounded by `withSendTimeout` (#31); the
    // idempotency key (if any) rides in the request options, not the payload.
    const { error } = await withSendTimeout(
      getResend(apiKey).emails.send(
        { from, to: order.email, subject, html, text },
        { idempotencyKey: options?.idempotencyKey },
      ),
      SEND_TIMEOUT_MS,
    );
    if (error) {
      throw new Error(
        `Resend failed to send shipping confirmation (${error.name}): ${error.message}`,
      );
    }
  },
};
