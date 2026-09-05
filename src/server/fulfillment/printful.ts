import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { logger } from "@/server/observability/logger";
import type {
  CreateFulfillmentInput,
  FulfillmentProvider,
  FulfillmentResult,
  ShippingAddress,
  TrackingInfo,
} from "./provider";

/**
 * Printful (print-on-demand) adapter — the real v1 REST client behind the
 * `FulfillmentProvider` seam (M4 #138). Everything above it (the submission
 * service, the outbox, checkout) is already built and mock-tested; this is the
 * live provider, swapped in purely by `PRINTFUL_API_KEY` presence in
 * `getFulfillmentProvider` (`index.ts`) — so nothing else changes when it turns on.
 *
 * A *thin HTTP client*, not a second catalog: the submission service resolves each
 * line's `sku → providerVariantId` (Printful's integer catalog id, carried as a
 * string) before we ever run — an unmapped line never reaches here. We only format
 * and POST. Mirrors `src/lib/stripe.ts`'s lazy singleton; there is no Printful SDK.
 *
 * Verified against the live v1 OpenAPI spec (`https://developers.printful.com/docs/openapi.json`,
 * last-modified 2026-09-02):
 *  - Bearer auth (`Authorization: Bearer <token>`); a single Store-level Private
 *    Token needs no `X-PF-Store-Id`.
 *  - `POST /orders?confirm=1` — one-call create that submits + charges immediately.
 *    We confirm because Stripe already captured payment, so Printful's
 *    draft/confirm review buffer buys us nothing (`?confirm=0` / omitted = a free
 *    draft, used only by the manual smoke test — see `docs/.../printful-setup.md`).
 *  - `GET /orders/{id}` → `{ code, result }` with `result.status` (a string) and
 *    `result.shipments[]` (`carrier`/`tracking_number`/`tracking_url`).
 */

const PRINTFUL_BASE_URL = "https://api.printful.com";

/**
 * Cap on a single Printful call. Submission runs in the background outbox drain
 * (never a user request path), so this only bounds a *hung* call so it can't wedge
 * the drain — comfortably above a healthy create (which validates the address and
 * charges server-side) yet well under the cron's own deadline.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Printful `status` values that mean the order was NOT accepted for fulfillment.
 * A create returning a 200 (the order exists, with an id) but already reading one
 * of these is a soft rejection → `FulfillmentResult.status: "failed"`. Every other
 * status (`pending`, `draft`, `inprocess`, …) means it's in flight → "submitted";
 * the poll cron reconciles the true state later via `getTracking`. The full
 * vocabulary per the spec's `Order.status`: draft, inreview, pending, failed,
 * canceled, inprocess, onhold, partial, fulfilled, archived.
 */
const REJECTED_ORDER_STATUSES = new Set(["failed", "canceled"]);

/**
 * Printful `status` values that mean the order has terminally failed *after* a
 * successful submission — the poll-side analogue of `REJECTED_ORDER_STATUSES`
 * (M4 #151). When `getTracking` reads one of these, the order will never ship, so
 * the poll cron flags it (`TrackingInfo.terminalFailure`) and reconciles it to a
 * terminal `FulfillmentStatus.FAILED` rather than re-polling it forever. Kept a
 * SEPARATE set from the create-side rejection above — a create-time soft rejection
 * (a 200 that already reads `failed`/`canceled`) and a post-submission terminal
 * failure are distinct lifecycle points that just happen to share a vocabulary
 * today, and each should stay independently evolvable. Everything else — `pending`,
 * `inprocess`, `onhold`, `partial`, `draft`, `inreview`, … — is in flight or shipped
 * (a shipment is signalled by a tracking number, not the status), so it is NOT
 * terminal and the order stays SUBMITTED for the next poll.
 */
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "canceled"]);

// --- Response shapes. Printful's payloads are external input, so they're validated
// with zod (repo convention). Only the fields we read are declared; zod strips the
// many others Printful returns. Tracking fields are `nullish` — an unshipped order
// carries the shipment object with null tracking.

const printfulShipmentSchema = z.object({
  carrier: z.string().nullish(),
  tracking_number: z.string().nullish(),
  tracking_url: z.string().nullish(),
});

const printfulOrderSchema = z.object({
  // Printful's order id is an integer; accept a string too and normalize to string
  // (it becomes `Order.fulfillmentExternalId`, and `GET /orders/{id}` takes either).
  id: z.union([z.number(), z.string()]),
  status: z.string(),
  shipments: z.array(printfulShipmentSchema).nullish(),
});

/** The success envelope: `{ code, result }` — we only need `result`. */
const printfulSuccessSchema = z.object({ result: printfulOrderSchema });

/** The error envelope: `{ code, result: "<msg>", error: { reason, message } }`. */
const printfulErrorSchema = z.object({
  result: z.string().optional(),
  error: z
    .object({ reason: z.string().optional(), message: z.string().optional() })
    .nullish(),
});

/**
 * A single-store Printful client: base URL + Bearer auth + a timeout-bounded
 * `fetch`. Lazily built and memoized — the `getStripe` pattern. Throws if the key
 * is unset so a misconfiguration fails loudly rather than hitting an
 * unauthenticated API (in practice the selector only builds a `PrintfulProvider`
 * once the key is present, so this is defense in depth).
 */
interface PrintfulClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

let clientSingleton: PrintfulClient | null = null;

function getClient(): PrintfulClient {
  if (clientSingleton) {
    return clientSingleton;
  }
  const key = env.PRINTFUL_API_KEY;
  if (!key) {
    throw new Error("PRINTFUL_API_KEY is not configured");
  }
  const client: PrintfulClient = {
    fetch(path, init) {
      return fetch(`${PRINTFUL_BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        // Bound a hung call so it can't wedge the outbox drain.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    },
  };
  clientSingleton = client;
  return client;
}

export class PrintfulProvider implements FulfillmentProvider {
  readonly name = "printful";

  async createOrder(input: CreateFulfillmentInput): Promise<FulfillmentResult> {
    const body = {
      // Our order id as Printful's `external_id`: one-to-one traceability in the
      // Printful dashboard (the mock mirrors this as `mock_${orderId}`), and the
      // natural dedupe handle if we ever adopt `?update_existing=1`.
      external_id: input.orderId,
      recipient: toRecipient(input.shippingAddress),
      items: input.items.map((item) => ({
        // Printful's catalog `variant_id` is a positive integer; the mapping is
        // carried as a string and guaranteed present here (the service throws
        // `FulfillmentNotMappedError` upstream if any line lacks it). Parsed
        // strictly so a mistyped mapping fails cleanly rather than shipping the
        // WRONG product — see `toVariantId`.
        variant_id: toVariantId(item.providerVariantId),
        quantity: item.quantity,
        // `retail_price` is Printful's OPTIONAL per-item price for the
        // customer-facing packing slip; sending it makes the slip show OUR retail
        // price instead of Printful's own base price (M4 #148). Printful wants a
        // plain decimal STRING ("19.99"), so this is the one place the line's
        // integer cents cross into a decimal — at the outbound HTTP edge only
        // (golden rule #3). Deliberately not `formatMoney`: that adds a currency
        // symbol and grouping ("$1,234.56"), which Printful would reject.
        retail_price: toRetailPrice(item.priceCents),
      })),
      // Declare the currency those per-item `retail_price` values are in (M4 #157).
      // Without it Printful frames every `retail_price` in its single store's default
      // currency, so a tenant transacting in a different currency (per-tenant
      // `Tenant.currency`, snapshot on `Order.currency`) gets a numerically-correct
      // but WRONG-currency packing slip. `retail_costs.currency` is the only v1 lever
      // for this — there is no per-order top-level `currency` field — and it sets the
      // slip's display label only (Printful still bills the store owner in the store's
      // own currency via the read-only `costs`). Verified currency-ONLY against the v1
      // OpenAPI spec: `retail_costs` declares NO required fields, so sending currency
      // alone is legal and, unlike a partial subtotal/discount/shipping/tax, can't
      // misstate the slip totals — the aggregate breakdown stays deferred (#148). The
      // "retail costs are used only if every item has a `retail_price`" gate is already
      // met (#148 sends one per line). Uppercased at this HTTP edge only — the currency
      // twin of `toRetailPrice`'s cents→decimal crossing (golden rule #3).
      retail_costs: { currency: toRetailCurrency(input.currency) },
    };

    // `confirm=1` submits + charges immediately (Stripe already captured payment).
    const res = await getClient().fetch("/orders?confirm=1", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (res.status === 400) {
      // Soft rejection: Printful validated the request and refused it (bad address,
      // unknown variant, external_id in use, …). A 400 carries no order id, so
      // synthesize a traceable, obviously-not-real external id to satisfy the
      // non-optional `FulfillmentResult.externalId` while returning a *resolved*
      // failure — never a throw — per the interface contract. #139 maps this onto
      // `FulfillmentStatus.FAILED` (a permanent state, not retried).
      logger.warn(
        { orderId: input.orderId, reason: await readError(res) },
        "printful: order rejected (soft failure)",
      );
      return {
        externalId: `printful_rejected_${input.orderId}`,
        status: "failed",
      };
    }

    if (!res.ok) {
      // 401 (bad/expired token — a config incident), 419/429 (rate limited), 5xx
      // (Printful down), or a network/timeout error (fetch rejects before we get
      // here): all transient or loud. Throw → the outbox backs off and retries,
      // then dead-letters. Never a per-order "failed".
      throw new Error(
        `printful: POST /orders failed with ${res.status} — ${await readError(res)}`,
      );
    }

    const { result } = printfulSuccessSchema.parse(await res.json());
    return {
      externalId: String(result.id),
      // A 200 means the order was accepted (it has an id); only an immediate
      // `failed`/`canceled` is a rejection.
      status: REJECTED_ORDER_STATUSES.has(result.status)
        ? "failed"
        : "submitted",
    };
  }

  async getTracking(externalId: string): Promise<TrackingInfo> {
    // `GET /orders/{id}` accepts the numeric Printful id we persisted as externalId.
    const res = await getClient().fetch(
      `/orders/${encodeURIComponent(externalId)}`,
    );

    if (!res.ok) {
      // No soft-failure channel here — `TrackingInfo.status` is a required string —
      // so any non-2xx (404 unknown order, 401, 5xx) or network/timeout throws for
      // the poll cron to retry/log.
      throw new Error(
        `printful: GET /orders/${externalId} failed with ${res.status} — ${await readError(res)}`,
      );
    }

    const { result } = printfulSuccessSchema.parse(await res.json());
    // Keep Printful's raw status string verbatim — it becomes
    // `Order.fulfillmentProviderStatus` (admin display only); our own closed
    // `FulfillmentStatus` enum is derived from it upstream, never here.
    const tracking: TrackingInfo = { status: result.status };

    // Map Printful's raw status onto the closed `terminalFailure` signal (M4 #151),
    // the poll-side analogue of the create path's soft rejection: a `canceled`/`failed`
    // order has terminally failed after submission and will never ship, so the poll
    // reconciles it to FAILED instead of re-polling it forever. Set only when true so
    // an in-flight/shipped order's `TrackingInfo` carries no spurious flag.
    if (TERMINAL_FAILURE_STATUSES.has(result.status)) {
      tracking.terminalFailure = true;
    }

    // An order can have multiple shipments (partial fulfillment, `status: "partial"`);
    // `TrackingInfo` carries one tracking set, so surface the first — a known,
    // documented simplification, not a blocker this milestone.
    const shipment = result.shipments?.[0];
    if (shipment?.carrier) tracking.carrier = shipment.carrier;
    if (shipment?.tracking_number)
      tracking.trackingNumber = shipment.tracking_number;
    if (shipment?.tracking_url) tracking.trackingUrl = shipment.tracking_url;
    return tracking;
  }
}

/**
 * Parse a provider mapping into Printful's positive-integer `variant_id`.
 *
 * The mapping is stored as free-form, length-capped text (the admin catalog form),
 * so only a *pure-digit* string maps to the intended catalog id exactly. A bare
 * `Number()` would silently coerce oddities to a DIFFERENT integer (`"1e3"` → 1000,
 * `"0x10"` → 16) and ship the wrong product; a typo (`"40l1"`) would become `NaN`.
 * Here anything that isn't pure digits becomes `NaN`, which `JSON.stringify` emits
 * as `null` → Printful rejects it with a 400 → a clean soft-fail (surfaced,
 * admin-fixable), never a wrong-product shipment. Presence is already guaranteed
 * upstream (`FulfillmentNotMappedError`); this guards the value's *shape*.
 */
function toVariantId(providerVariantId: string | undefined): number {
  const trimmed = providerVariantId?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/**
 * Format a line's integer-cents unit price as Printful's `retail_price` — a plain
 * decimal string, e.g. `1999 → "19.99"`, `1500 → "15.00"` (M4 #148). This is the
 * single point where the money boundary (golden rule #3) is crossed: cents are the
 * internal unit everywhere else, and only here, at the outbound HTTP edge, do they
 * become a two-decimal string. `/ 100` then `toFixed(2)` is exact for any realistic
 * order price (well within `Number.MAX_SAFE_INTEGER`). Not `formatMoney`, whose
 * currency symbol and grouping separators Printful would reject.
 */
function toRetailPrice(priceCents: number): string {
  return (priceCents / 100).toFixed(2);
}

/**
 * Map the order's currency (`Order.currency` — lowercase ISO 4217, Stripe's
 * convention) to Printful's `retail_costs.currency`: an uppercase 3-letter code,
 * e.g. `"usd" → "USD"` (M4 #157). The currency twin of `toRetailPrice` — the single
 * place the order's currency crosses the outbound HTTP boundary. No allowlist check:
 * `Order.currency` is already constrained to the supported set upstream (the store-
 * currency setter), so the adapter stays a thin client and only reshapes the case
 * Printful expects, never re-validates.
 */
function toRetailCurrency(currency: string): string {
  return currency.toUpperCase();
}

/**
 * Map our provider-agnostic `ShippingAddress` onto Printful's `recipient` shape.
 * Undefined optionals (`address2`, `state_code`) are dropped by `JSON.stringify`.
 * Requiredness is enforced upstream (checkout's zod schema + the service's
 * `FulfillmentAddressMissingError`), so no validation is repeated here.
 */
function toRecipient(address: ShippingAddress) {
  return {
    name: address.name,
    address1: address.line1,
    address2: address.line2,
    city: address.city,
    state_code: address.state,
    country_code: address.country,
    zip: address.postalCode,
  };
}

/**
 * Best-effort human reason from a Printful error body, for logs/messages only.
 * Never throws — a soft rejection must resolve and a transient throw must not be
 * masked by a parse error — so a non-JSON or unexpected body falls back to the
 * HTTP status text.
 */
async function readError(res: Response): Promise<string> {
  try {
    const parsed = printfulErrorSchema.safeParse(await res.json());
    if (parsed.success) {
      return parsed.data.error?.message ?? parsed.data.result ?? res.statusText;
    }
  } catch {
    // Non-JSON body (e.g. a proxy's HTML 5xx page) — fall through to statusText.
  }
  return res.statusText;
}
