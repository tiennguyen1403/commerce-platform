import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Order, OrderItem, Tenant } from "@prisma/client";
import {
  emailService,
  EmailNotConfiguredError,
  EmailSendTimeoutError,
} from "@/server/services/email.service";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { env } from "@/lib/env";
import type { OrderWithItems } from "@/server/repositories/order.repository";

/**
 * Unit tests for the transactional-email service, with the Resend client and the
 * tenant repository mocked and `@/lib/env` stubbed so config can be toggled. The
 * focus is the rendered output — money formatting, the store branding, and the
 * HTML escaping of admin-authored order titles — plus the send-time config gate.
 */

// `sendMock` must exist before the `resend` mock factory (which is hoisted).
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

// `Resend` is `new`-ed in the service, so the mock must be constructable — a
// class, not an arrow (an arrow function can't be used with `new`).
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));
vi.mock("@/server/repositories/tenant.repository", () => ({
  tenantRepository: { findById: vi.fn(), findBySlug: vi.fn() },
}));
vi.mock("@/lib/env", () => ({
  env: { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "Acme <orders@acme.test>" },
}));

const findById = vi.mocked(tenantRepository.findById);

function tenant(o: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant_1",
    slug: "acme",
    name: "Acme Store",
    currency: "usd",
    themeHue: 162,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...o,
  };
}

function order(o: Partial<Order> = {}): Order {
  return {
    id: "order_1",
    tenantId: "tenant_1",
    orderNumber: "20250101-ABCDEF",
    status: "PAID",
    email: "shopper@example.com",
    userId: null,
    totalCents: 10000,
    currency: "usd",
    stripePaymentIntentId: "pi_1",
    oversold: false,
    // Fulfillment (M4 #134): nullable/defaulted columns, unset in this fixture.
    shipName: null,
    shipLine1: null,
    shipLine2: null,
    shipCity: null,
    shipState: null,
    shipPostalCode: null,
    shipCountry: null,
    fulfillmentProvider: null,
    fulfillmentExternalId: null,
    fulfillmentStatus: "NOT_SUBMITTED",
    fulfillmentProviderStatus: null,
    trackingCarrier: null,
    trackingNumber: null,
    trackingUrl: null,
    fulfillmentStuckAt: null,
    fulfillmentErrorCount: 0,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...o,
  };
}

function orderItem(o: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "item_1",
    orderId: "order_1",
    variantId: "v1",
    titleSnapshot: "Widget",
    priceCents: 2500,
    quantity: 1,
    ...o,
  };
}

function orderWithItems(o: Partial<OrderWithItems> = {}): OrderWithItems {
  return { ...order(), items: [orderItem()], ...o };
}

type SentEmail = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};
const lastEmail = (): SentEmail => sendMock.mock.calls[0][0] as SentEmail;

// Mirrors the service's private send-timeout ceiling (#31): the test only needs
// to advance past it, so exact drift is tolerated (a raised ceiling would make
// this test time out loudly rather than pass silently).
const SEND_TIMEOUT_MS = 5_000;

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
  findById.mockReset();
  findById.mockResolvedValue(tenant());
  // Restore the configured-email defaults; individual tests unset as needed.
  env.RESEND_API_KEY = "re_test_key";
  env.EMAIL_FROM = "Acme <orders@acme.test>";
});

describe("emailService.sendOrderConfirmation", () => {
  it("sends via Resend with the store branding and a per-line + total summary", async () => {
    findById.mockResolvedValue(tenant({ name: "Acme Store" }));

    await emailService.sendOrderConfirmation(
      orderWithItems({
        orderNumber: "20250101-ABCDEF",
        email: "shopper@example.com",
        totalCents: 10000,
        currency: "usd",
        items: [
          orderItem({
            titleSnapshot: "Widget — Blue",
            priceCents: 2500,
            quantity: 2,
          }),
          orderItem({
            id: "item_2",
            titleSnapshot: "Gadget — Red",
            priceCents: 5000,
            quantity: 1,
          }),
        ],
      }),
    );

    expect(findById).toHaveBeenCalledWith("tenant_1");
    const email = lastEmail();
    expect(email.from).toBe("Acme <orders@acme.test>");
    expect(email.to).toBe("shopper@example.com");
    expect(email.subject).toBe("Order 20250101-ABCDEF confirmed");

    // Money is formatted at the edge — per line (unit + line total) and overall.
    expect(email.html).toContain("$100.00");
    expect(email.html).toContain("$25.00");
    expect(email.html).toContain("$50.00");
    expect(email.html).toContain("Acme Store");

    // The plain-text alternative carries the same figures for deliverability.
    expect(email.text).toContain("Widget — Blue (Qty 2 x $25.00) = $50.00");
    expect(email.text).toContain("Total: $100.00");
  });

  it("forwards an idempotency key to Resend as request options (outbox drain)", async () => {
    await emailService.sendOrderConfirmation(orderWithItems(), {
      idempotencyKey: "oc_order_1",
    });

    // The key rides in the second arg (request options), not the payload — see
    // Resend's `CreateEmailRequestOptions`.
    expect(sendMock.mock.calls[0][1]).toMatchObject({
      idempotencyKey: "oc_order_1",
    });
  });

  it("sends without an idempotency key when none is given", async () => {
    await emailService.sendOrderConfirmation(orderWithItems());

    expect(sendMock.mock.calls[0][1]).toEqual({ idempotencyKey: undefined });
  });

  it("escapes HTML-significant characters from admin-authored text in the HTML body", async () => {
    findById.mockResolvedValue(tenant({ name: `A&W "Root" <b>'s` }));

    await emailService.sendOrderConfirmation(
      orderWithItems({
        items: [orderItem({ titleSnapshot: `<script>alert("x")&'</script>` })],
      }),
    );

    const email = lastEmail();
    // The raw markup must never reach the HTML body verbatim.
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&amp;");
    expect(email.html).toContain("&quot;");
    expect(email.html).toContain("&#39;");
    // The store name is escaped on the same path.
    expect(email.html).toContain("A&amp;W");

    // The plain-text part is not HTML, so it carries the raw title unescaped.
    expect(email.text).toContain(`<script>alert("x")&'</script>`);
  });

  it("falls back to a neutral store name when the tenant can't be resolved", async () => {
    findById.mockResolvedValue(null);

    await emailService.sendOrderConfirmation(orderWithItems());

    const email = lastEmail();
    expect(email.html).toContain("our store");
    expect(email.text).toContain("our store");
  });

  it("throws when Resend reports an error", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", message: "Too many requests" },
    });

    await expect(
      emailService.sendOrderConfirmation(orderWithItems()),
    ).rejects.toThrow(
      "Resend failed to send order confirmation (rate_limit_exceeded): Too many requests",
    );
  });

  it("throws EmailSendTimeoutError when a hung Resend send exceeds the timeout (#31)", async () => {
    // A send that never settles stands in for a hung Resend call; fake timers let
    // us trip the bound without waiting real seconds.
    vi.useFakeTimers();
    try {
      sendMock.mockReturnValue(new Promise(() => {}));

      const promise = emailService.sendOrderConfirmation(orderWithItems());
      // Attach the rejection expectation before advancing time so the eventual
      // rejection is never flagged as unhandled.
      const assertion = expect(promise).rejects.toBeInstanceOf(
        EmailSendTimeoutError,
      );

      // Flush the awaited config gate + tenant lookup so the timeout timer is
      // scheduled, then advance past it to trip the bound.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a healthy send that resolves within the bound", async () => {
    // Guards against the timeout firing (or leaking a timer) on the happy path:
    // a normal resolved send settles the race first and clears the timer.
    vi.useFakeTimers();
    try {
      sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });

      await expect(
        emailService.sendOrderConfirmation(orderWithItems()),
      ).resolves.toBeUndefined();
      // No timer should be left pending once the send has resolved.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws EmailNotConfiguredError before any work when the API key is unset", async () => {
    env.RESEND_API_KEY = undefined;

    await expect(
      emailService.sendOrderConfirmation(orderWithItems()),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    // The config gate runs before any DB or network work.
    expect(findById).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("throws EmailNotConfiguredError when the from address is unset", async () => {
    env.EMAIL_FROM = undefined;

    await expect(
      emailService.sendOrderConfirmation(orderWithItems()),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
  });
});

/**
 * #40: an oversold order — payment captured, but the atomic stock decrement
 * couldn't fill one or more lines — must NOT get a reassuring "order confirmed"
 * email. The copy is chosen from the persisted `order.oversold` flag.
 */
describe("emailService.sendOrderConfirmation — oversold order (#40)", () => {
  it("sends a distinct 'can't fulfil / refund' message, never a confirmation", async () => {
    await emailService.sendOrderConfirmation(
      orderWithItems({ orderNumber: "20250101-ABCDEF", oversold: true }),
    );

    const email = lastEmail();
    // Neither subject nor body may tell the shopper the order is confirmed.
    expect(email.subject).toBe("Update on your order 20250101-ABCDEF");
    expect(email.subject).not.toContain("confirmed");
    expect(email.html).not.toContain("your order is confirmed");
    expect(email.text).not.toContain("your order is confirmed");

    // It explains the shortfall and the refund instead.
    expect(email.html).toContain("fulfil part of this order");
    expect(email.html).toContain("no longer in stock");
    expect(email.html.toLowerCase()).toContain("refund");
    expect(email.text).toContain("no longer in stock");
    expect(email.text.toLowerCase()).toContain("refund");
  });

  it("still lists the ordered items and total for reference", async () => {
    await emailService.sendOrderConfirmation(
      orderWithItems({
        oversold: true,
        totalCents: 7500,
        currency: "usd",
        items: [
          orderItem({
            titleSnapshot: "Widget — Blue",
            priceCents: 2500,
            quantity: 3,
          }),
        ],
      }),
    );

    const email = lastEmail();
    expect(email.html).toContain("Widget — Blue");
    expect(email.html).toContain("$75.00");
    expect(email.text).toContain("Total: $75.00");
  });

  it("keeps the standard confirmation for a normally-allocated order", async () => {
    await emailService.sendOrderConfirmation(
      orderWithItems({ orderNumber: "20250101-ZZZZZZ", oversold: false }),
    );

    const email = lastEmail();
    expect(email.subject).toBe("Order 20250101-ZZZZZZ confirmed");
    expect(email.html).toContain("your order is confirmed");
    expect(email.html).not.toContain("fulfil part of this order");
  });
});

/**
 * #141: the shipping-confirmation email, sent from the poll-fulfillment reconcile
 * via the same outbox path. A shipped order carries the tracking the reconcile
 * persisted (carrier/number/url) plus its `ship*` address; the render shows the
 * carrier + a tracking link + the address, escaping every shopper-un-authored value.
 */
describe("emailService.sendShippingConfirmation", () => {
  function shippedOrder(o: Partial<OrderWithItems> = {}): OrderWithItems {
    return orderWithItems({
      orderNumber: "20250101-SHIP01",
      email: "shopper@example.com",
      shipName: "Ada Lovelace",
      shipLine1: "1 Analytical Ave",
      shipLine2: "Apt 2",
      shipCity: "San Francisco",
      shipState: "CA",
      shipPostalCode: "94103",
      shipCountry: "US",
      trackingCarrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      trackingUrl: "https://track.example.test/1Z999AA10123456784",
      items: [orderItem({ titleSnapshot: "Widget — Blue", quantity: 2 })],
      ...o,
    });
  }

  it("sends via Resend with store branding, the tracking carrier + link, and the address", async () => {
    findById.mockResolvedValue(tenant({ name: "Acme Store" }));

    await emailService.sendShippingConfirmation(shippedOrder());

    expect(findById).toHaveBeenCalledWith("tenant_1");
    const email = lastEmail();
    expect(email.from).toBe("Acme <orders@acme.test>");
    expect(email.to).toBe("shopper@example.com");
    expect(email.subject).toBe("Your order 20250101-SHIP01 has shipped");

    // AC: shows the tracking carrier + a tracking link.
    expect(email.html).toContain("UPS");
    expect(email.html).toContain("1Z999AA10123456784");
    expect(email.html).toContain(
      'href="https://track.example.test/1Z999AA10123456784"',
    );
    expect(email.html).toContain("Track your shipment");
    expect(email.html).toContain("Acme Store");

    // The shipping address and the ordered item (title) are rendered.
    expect(email.html).toContain("Ada Lovelace");
    expect(email.html).toContain("1 Analytical Ave");
    expect(email.html).toContain("San Francisco, CA 94103");
    expect(email.html).toContain("Widget — Blue");

    // The plain-text alternative carries the same tracking details for deliverability.
    expect(email.text).toContain("Carrier: UPS");
    expect(email.text).toContain("Tracking number: 1Z999AA10123456784");
    expect(email.text).toContain(
      "Track your shipment: https://track.example.test/1Z999AA10123456784",
    );
    expect(email.text).toContain("Ada Lovelace");
  });

  it("forwards an idempotency key to Resend as request options (outbox drain)", async () => {
    await emailService.sendShippingConfirmation(shippedOrder(), {
      idempotencyKey: "sc_order_1",
    });

    expect(sendMock.mock.calls[0][1]).toMatchObject({
      idempotencyKey: "sc_order_1",
    });
  });

  it("escapes HTML-significant characters in order titles and the address", async () => {
    findById.mockResolvedValue(tenant({ name: `A&W "Root" <b>'s` }));

    await emailService.sendShippingConfirmation(
      shippedOrder({
        shipName: `<script>alert("x")&'</script>`,
        items: [orderItem({ titleSnapshot: `<b>Widget</b> & "Co"` })],
      }),
    );

    const email = lastEmail();
    // Raw markup from admin/address text must never reach the HTML body verbatim.
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&lt;b&gt;Widget&lt;/b&gt;");
    expect(email.html).toContain("&amp;");
    expect(email.html).toContain("A&amp;W");
    // The plain-text part is not HTML, so it carries the raw title unescaped.
    expect(email.text).toContain(`<b>Widget</b> & "Co"`);
  });

  it("renders the tracking link only for an http(s) url, else falls back to text", async () => {
    await emailService.sendShippingConfirmation(
      shippedOrder({ trackingUrl: "javascript:alert(1)" }),
    );

    const email = lastEmail();
    // A non-web (or unsafe) url is never rendered as a link...
    expect(email.html).not.toContain("Track your shipment");
    expect(email.html).not.toContain("javascript:");
    expect(email.text).not.toContain("Track your shipment:");
    // ...but the carrier + tracking number still show.
    expect(email.html).toContain("UPS");
    expect(email.html).toContain("1Z999AA10123456784");
  });

  it("omits the carrier line when the shipment has no carrier (number is the signal)", async () => {
    // The poll maps a carrier-less shipment to `trackingCarrier: null` (Printful can
    // report a tracking number with no carrier), so this is a real runtime shape.
    await emailService.sendShippingConfirmation(
      shippedOrder({ trackingCarrier: null }),
    );

    const email = lastEmail();
    expect(email.html).not.toContain("Carrier");
    expect(email.text).not.toContain("Carrier:");
    // The tracking number + link still render.
    expect(email.html).toContain("1Z999AA10123456784");
    expect(email.html).toContain("Track your shipment");
  });

  it("omits the address section when the order carries no shipping address", async () => {
    await emailService.sendShippingConfirmation(
      shippedOrder({
        shipName: null,
        shipLine1: null,
        shipLine2: null,
        shipCity: null,
        shipState: null,
        shipPostalCode: null,
        shipCountry: null,
      }),
    );

    const email = lastEmail();
    expect(email.html).not.toContain("Shipping to");
    expect(email.text).not.toContain("Shipping to:");
    // The tracking details are unaffected.
    expect(email.html).toContain("1Z999AA10123456784");
  });

  it("falls back to a neutral store name when the tenant can't be resolved", async () => {
    findById.mockResolvedValue(null);

    await emailService.sendShippingConfirmation(shippedOrder());

    const email = lastEmail();
    expect(email.html).toContain("our store");
    expect(email.text).toContain("our store");
  });

  it("throws EmailNotConfiguredError before any work when the API key is unset", async () => {
    env.RESEND_API_KEY = undefined;

    await expect(
      emailService.sendShippingConfirmation(shippedOrder()),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(findById).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("throws when Resend reports an error", async () => {
    sendMock.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", message: "Too many requests" },
    });

    await expect(
      emailService.sendShippingConfirmation(shippedOrder()),
    ).rejects.toThrow(
      "Resend failed to send shipping confirmation (rate_limit_exceeded): Too many requests",
    );
  });
});
