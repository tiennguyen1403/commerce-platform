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
 * An `externalId` CONTAINING this marker makes the mock's `getTracking` progression
 * end in a provider TERMINAL failure (status `"canceled"`, `terminalFailure: true`,
 * no tracking) instead of a shipment — the post-submission analogue of
 * `MOCK_FAILING_VARIANT_ID`'s create-time soft rejection (M4 #151). It keys off the
 * external id (all `getTracking` ever receives), so a caller drives the poll cron's
 * terminal-exit path deterministically by giving a SUBMITTED order a
 * `fulfillmentExternalId` that carries it (e.g. `uniqueId("mock-TERMINAL_FAIL")`).
 */
export const MOCK_TERMINAL_FAIL_MARKER = "TERMINAL_FAIL";

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
 * so a polling caller (the M4 poll cron) observes a shipment appear over time. An
 * external id carrying `MOCK_TERMINAL_FAIL_MARKER` instead progresses `"submitted"`
 * → a provider TERMINAL failure (`"canceled"`, `terminalFailure: true`, no tracking),
 * the deterministic handle on the poll's terminal-exit path (#151).
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
    // Terminal-failure progression (#151): a marked external id is cancelled/failed
    // after submission rather than shipped — no tracking number, flagged terminal so
    // the poll moves it to FulfillmentStatus.FAILED instead of re-polling it forever.
    if (externalId.includes(MOCK_TERMINAL_FAIL_MARKER)) {
      return { status: "canceled", terminalFailure: true };
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
