import "server-only";
import type {
  CreateFulfillmentInput,
  FulfillmentProvider,
  FulfillmentResult,
  TrackingInfo,
} from "./provider";

/**
 * A line carrying this sentinel as its `providerVariantId` makes the mock's
 * `createOrder` resolve to a `"failed"` result instead of `"submitted"`. It gives
 * tests (and manual dev checks) a deterministic handle on the *soft-rejection*
 * path — a variant/address the real provider would reject — which
 * `FulfillmentResult.status` normalizes into a resolved value, not a thrown error.
 */
export const MOCK_FAILING_VARIANT_ID = "MOCK_FAIL";

/**
 * A deterministic, in-memory `FulfillmentProvider` — the CI/test default and dev
 * fallback (no `PRINTFUL_API_KEY` needed), and the reason everything above the
 * provider boundary is buildable before the real Printful adapter exists
 * (M4 #137). Makes no network call and holds no real credentials.
 *
 * `createOrder` returns a canned `{ externalId, status }`: `"submitted"` for a
 * normal order, or `"failed"` when any line carries `MOCK_FAILING_VARIANT_ID`.
 * `getTracking` returns a canned progression per `externalId` — `"submitted"` on
 * the first poll, then `"shipped"` with a fake carrier + tracking on later polls —
 * so a polling caller (the M4 poll cron) observes a shipment appear over time.
 * The progression is per-instance state, so treat one `MockProvider` as one
 * process's provider (the selector memoizes a singleton for exactly this reason).
 */
export class MockProvider implements FulfillmentProvider {
  readonly name = "mock";

  /** Poll count per `externalId`, driving the `getTracking` progression. */
  private readonly pollsByExternalId = new Map<string, number>();

  async createOrder(input: CreateFulfillmentInput): Promise<FulfillmentResult> {
    // Deterministic and traceable: mirrors the real adapter's plan to pass our
    // `Order.id` as the provider's `external_id`, so a mock id reads the same way.
    const externalId = `mock_${input.orderId}`;
    const rejected = input.items.some(
      (item) => item.providerVariantId === MOCK_FAILING_VARIANT_ID,
    );
    if (rejected) {
      return { externalId, status: "failed" };
    }
    // Register the accepted order so its tracking can progress from here.
    this.pollsByExternalId.set(externalId, 0);
    return { externalId, status: "submitted" };
  }

  async getTracking(externalId: string): Promise<TrackingInfo> {
    const polls = (this.pollsByExternalId.get(externalId) ?? 0) + 1;
    this.pollsByExternalId.set(externalId, polls);
    // First poll: the provider accepted the order but hasn't shipped it yet.
    if (polls < 2) {
      return { status: "submitted" };
    }
    // Shipped: a canned carrier + tracking, deterministic from the external id.
    return {
      status: "shipped",
      carrier: "Mock Carrier",
      trackingNumber: `MOCK-${externalId}`,
      trackingUrl: `https://tracking.example.test/${externalId}`,
    };
  }
}
