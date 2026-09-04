import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  CreateFulfillmentInput,
  ShippingAddress,
} from "@/server/fulfillment/provider";

/**
 * The real Printful v1 adapter, exercised against a stubbed `fetch` (no network).
 * `@/lib/env` is mocked with the key present — the selector only ever builds a
 * `PrintfulProvider` once `PRINTFUL_API_KEY` is set — and the structured logger is
 * spied so the soft-rejection path's warn is observable and silent. The contract
 * under test: correct request shaping (URL/`confirm=1`, Bearer auth, recipient +
 * integer `variant_id`, no `retail_price`), a 400 resolved to `"failed"` (never a
 * throw), an immediate `failed` order status mapped to `"failed"`, everything else
 * non-2xx thrown (transient), and the tracking mapping off `shipments[0]`.
 */

vi.mock("@/lib/env", () => ({
  env: { PRINTFUL_API_KEY: "pf_test_key", NODE_ENV: "test" },
}));

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("@/server/observability/logger", () => ({
  logger: { warn: warnMock, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { PrintfulProvider } from "@/server/fulfillment/printful";

const ADDRESS: ShippingAddress = {
  name: "Ada Lovelace",
  line1: "1 Analytical Ave",
  city: "San Francisco",
  state: "CA",
  postalCode: "94103",
  country: "US",
};

function input(
  o: Partial<CreateFulfillmentInput> = {},
): CreateFulfillmentInput {
  return {
    orderId: "order_1",
    items: [{ sku: "TEE-S", quantity: 2, providerVariantId: "4011" }],
    shippingAddress: ADDRESS,
    ...o,
  };
}

/** A Printful-style JSON `Response` at a given HTTP status. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

describe("PrintfulProvider", () => {
  it("is named 'printful'", () => {
    expect(new PrintfulProvider().name).toBe("printful");
  });

  describe("createOrder", () => {
    it("POSTs /orders?confirm=1 with Bearer auth and the mapped body", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          result: { id: 987, status: "pending" },
        }),
      );

      const result = await new PrintfulProvider().createOrder(input());

      expect(result).toEqual({ externalId: "987", status: "submitted" });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.printful.com/orders?confirm=1");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer pf_test_key",
        "Content-Type": "application/json",
      });
      // Bounded so a hung call can't wedge the outbox drain.
      expect(init.signal).toBeInstanceOf(AbortSignal);

      const sent = JSON.parse(init.body as string);
      expect(sent).toEqual({
        external_id: "order_1",
        recipient: {
          name: "Ada Lovelace",
          address1: "1 Analytical Ave",
          city: "San Francisco",
          state_code: "CA",
          country_code: "US",
          zip: "94103",
        },
        // `variant_id` is an integer; `retail_price` is absent by design (#148).
        items: [{ variant_id: 4011, quantity: 2 }],
      });
      expect(sent.recipient).not.toHaveProperty("address2");
      expect(sent.items[0]).not.toHaveProperty("retail_price");
    });

    it("includes recipient.address2 only when line2 is present", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { result: { id: 1, status: "pending" } }),
      );

      await new PrintfulProvider().createOrder(
        input({ shippingAddress: { ...ADDRESS, line2: "Apt 4" } }),
      );

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(sent.recipient.address2).toBe("Apt 4");
    });

    it("resolves to 'failed' (not a throw) on a 400 soft rejection", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, {
          code: 400,
          result: "Bad request",
          error: { reason: "BadRequest", message: "Invalid recipient zip" },
        }),
      );

      const result = await new PrintfulProvider().createOrder(input());

      expect(result).toEqual({
        externalId: "printful_rejected_order_1",
        status: "failed",
      });
      // The reason is preserved for operators even though the interface can't carry it.
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock.mock.calls[0][0]).toMatchObject({
        orderId: "order_1",
        reason: "Invalid recipient zip",
      });
    });

    it("maps an immediate 'failed' order status to 'failed' with the real id", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { result: { id: 555, status: "failed" } }),
      );

      expect(await new PrintfulProvider().createOrder(input())).toEqual({
        externalId: "555",
        status: "failed",
      });
      // A 200 is not a soft-rejection log — only a 400 warns.
      expect(warnMock).not.toHaveBeenCalled();
    });

    it("maps an immediate 'canceled' order status to 'failed'", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { result: { id: 556, status: "canceled" } }),
      );

      expect(await new PrintfulProvider().createOrder(input())).toEqual({
        externalId: "556",
        status: "failed",
      });
    });

    it("still resolves a 400 to 'failed' when the error body is not JSON", async () => {
      // The load-bearing invariant: `readError` never throws, so a soft rejection
      // always resolves — even a proxy's HTML 5xx-style page on a 400 must not
      // become a transient throw.
      fetchMock.mockResolvedValue(
        new Response("<html>Bad Request</html>", {
          status: 400,
          headers: { "content-type": "text/html" },
        }),
      );

      const result = await new PrintfulProvider().createOrder(input());

      expect(result).toEqual({
        externalId: "printful_rejected_order_1",
        status: "failed",
      });
      expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it("sends variant_id: null for a non-integer mapping (never the wrong product)", async () => {
      // "1e3" is parseable by Number() to 1000 — a DIFFERENT product. The strict
      // parse must instead emit null so Printful 400s it into a clean soft-fail.
      fetchMock.mockResolvedValue(
        jsonResponse(200, { result: { id: 1, status: "pending" } }),
      );

      await new PrintfulProvider().createOrder(
        input({
          items: [{ sku: "TEE-S", quantity: 1, providerVariantId: "1e3" }],
        }),
      );

      const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(sent.items[0].variant_id).toBeNull();
    });

    it("throws on 401 (auth/config) so the outbox retries then dead-letters", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, { code: 401, result: "Unauthorized" }),
      );

      await expect(new PrintfulProvider().createOrder(input())).rejects.toThrow(
        /401/,
      );
    });

    it("throws on 5xx (transient)", async () => {
      fetchMock.mockResolvedValue(jsonResponse(500, {}));

      await expect(new PrintfulProvider().createOrder(input())).rejects.toThrow(
        /500/,
      );
    });

    it("throws on a network/timeout error (transient)", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));

      await expect(new PrintfulProvider().createOrder(input())).rejects.toThrow(
        /network down/,
      );
    });
  });

  describe("getTracking", () => {
    it("GETs the order and maps status + first shipment to TrackingInfo", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          result: {
            id: 987,
            status: "fulfilled",
            shipments: [
              {
                carrier: "FEDEX",
                service: "FedEx SmartPost",
                tracking_number: "TN123",
                tracking_url: "https://track.example.test/TN123",
              },
            ],
          },
        }),
      );

      const info = await new PrintfulProvider().getTracking("987");

      expect(info).toEqual({
        status: "fulfilled",
        carrier: "FEDEX",
        trackingNumber: "TN123",
        trackingUrl: "https://track.example.test/TN123",
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.printful.com/orders/987");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer pf_test_key",
      });
    });

    it("returns just the raw status when there are no shipments yet", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          result: { id: 1, status: "pending", shipments: [] },
        }),
      );

      expect(await new PrintfulProvider().getTracking("1")).toEqual({
        status: "pending",
      });
    });

    it("omits tracking fields a shipment leaves null", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          result: {
            id: 2,
            status: "inprocess",
            shipments: [
              { carrier: "USPS", tracking_number: null, tracking_url: null },
            ],
          },
        }),
      );

      expect(await new PrintfulProvider().getTracking("2")).toEqual({
        status: "inprocess",
        carrier: "USPS",
      });
    });

    it("flags a 'canceled' order as a terminal failure (no tracking)", async () => {
      // The provider cancelled the order after submission — the poll's terminal-exit
      // signal (#151). The raw status is kept for display; `terminalFailure` is the
      // provider-agnostic flag the service reads.
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          result: { id: 3, status: "canceled", shipments: [] },
        }),
      );

      expect(await new PrintfulProvider().getTracking("3")).toEqual({
        status: "canceled",
        terminalFailure: true,
      });
    });

    it("flags a 'failed' order as a terminal failure", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { result: { id: 4, status: "failed" } }),
      );

      expect(await new PrintfulProvider().getTracking("4")).toEqual({
        status: "failed",
        terminalFailure: true,
      });
    });

    it("does not flag an in-flight status (e.g. onhold) as terminal", async () => {
      // `onhold` is transient, not terminal — the order stays SUBMITTED and is
      // re-polled, so no `terminalFailure` flag leaks onto its TrackingInfo.
      fetchMock.mockResolvedValue(
        jsonResponse(200, { result: { id: 5, status: "onhold" } }),
      );

      const info = await new PrintfulProvider().getTracking("5");
      expect(info).toEqual({ status: "onhold" });
      expect(info.terminalFailure).toBeUndefined();
    });

    it("throws on a non-2xx (e.g. 404 unknown order)", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, { code: 404, result: "Not Found" }),
      );

      await expect(new PrintfulProvider().getTracking("999")).rejects.toThrow(
        /404/,
      );
    });
  });
});
