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
 * An `externalId` CONTAINING this marker makes the mock's `getTracking` PARK the order
 * in a non-terminal provider hold on every poll (status `"onhold"`, no tracking,
 * `terminalFailure` unset) instead of ever shipping — a Printful `onhold`/`inreview`
 * that never resolves. It's the deterministic handle on the poll cron's STUCK-open-
 * shipment path (M4 #155): give a SUBMITTED order (created past the stuck-age threshold)
 * a `fulfillmentExternalId` carrying this, and the poll surfaces it as stuck WITHOUT
 * shipping or terminally failing it — the age-based analogue of the status-based
 * `MOCK_TERMINAL_FAIL_MARKER`. Needed because the plain progression always resolves to
 * shipped on the second poll, so nothing else can hold an order open across runs.
 */
export const MOCK_ONHOLD_MARKER = "ONHOLD";

/**
 * An `externalId` CONTAINING this marker makes the mock's `getTracking` THROW on every
 * poll — a persistent provider fault (a 4xx/5xx that never clears, a bad/stale external
 * id, a provider-side data problem) the poll can never read past. It's the deterministic
 * handle on the poll cron's ERRORING-open-shipment path (M4 #163): give a SUBMITTED order
 * a `fulfillmentExternalId` carrying this and every poll's `getTracking` rejects, so the
 * order is left SUBMITTED and its consecutive-error streak (`Order.fulfillmentErrorCount`)
 * climbs until the poll surfaces it as erroring-too-long — the thrown-error analogue of the
 * clean-but-never-resolving `MOCK_ONHOLD_MARKER`. Unlike the other markers it throws from
 * the FIRST poll (a persistent fault has no "accepted then progressed" phase), so it is
 * checked before the poll-count progression below.
 */
export const MOCK_ERROR_MARKER = "GETTRACKING_ERROR";

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
 * the deterministic handle on the poll's terminal-exit path (#151); one carrying
 * `MOCK_ONHOLD_MARKER` parks in a non-terminal `"onhold"` on every poll (never ships,
 * never fails), the handle on the stuck-open-shipment path (#155); one carrying
 * `MOCK_ERROR_MARKER` makes `getTracking` THROW on every poll, the handle on the
 * erroring-open-shipment path (#163).
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
    // Persistent getTracking failure (#163): a marked external id throws on EVERY poll —
    // a bad/stale external id or a provider data problem the poll can never read past — so
    // the order's consecutive-error streak climbs until it is surfaced as erroring-too-long.
    // Checked before the progression below because a persistent fault has no "accepted then
    // progressed" phase: it fails from the very first poll.
    if (externalId.includes(MOCK_ERROR_MARKER)) {
      throw new Error(`mock getTracking: persistent failure for ${externalId}`);
    }
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
    // Perpetual provider hold (#155): a marked external id parks in a non-terminal
    // `onhold` on every poll — no tracking, not flagged terminal — so a poll never
    // ships or fails it and can only ever surface it as a STUCK open shipment (which
    // is age-based, from the order's `createdAt`, not this status string).
    if (externalId.includes(MOCK_ONHOLD_MARKER)) {
      return { status: "onhold" };
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
