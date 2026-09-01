import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Order, OrderItem, Tenant } from "@prisma/client";
import {
  emailService,
  EmailNotConfiguredError,
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
    totalCents: 10000,
    currency: "usd",
    stripePaymentIntentId: "pi_1",
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
