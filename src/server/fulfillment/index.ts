import "server-only";
import { env } from "@/lib/env";
import type { FulfillmentProvider } from "./provider";
import { MockProvider } from "./mock";
import { PrintfulProvider } from "./printful";

/**
 * The fulfillment module's public surface: the provider abstraction + the
 * selector that picks the live provider. Everything outside `src/server/fulfillment`
 * depends only on these — never on a concrete adapter — so swapping Printful for
 * a mock (or Printify) touches no order/checkout code, per `provider.ts`'s promise.
 */
export type {
  CreateFulfillmentInput,
  FulfillmentLineItem,
  FulfillmentProvider,
  FulfillmentResult,
  ShippingAddress,
  TrackingInfo,
} from "./provider";
export {
  MockProvider,
  MOCK_FAILING_VARIANT_ID,
  MOCK_TERMINAL_FAIL_MARKER,
} from "./mock";
export { PrintfulProvider } from "./printful";

// Lazily-constructed singletons (the `getStripe` pattern). The mock keeps
// per-process tracking state, so it MUST be shared, not rebuilt per call.
let mockSingleton: MockProvider | null = null;
let printfulSingleton: PrintfulProvider | null = null;

/**
 * Resolve the active fulfillment provider, keyed off `PRINTFUL_API_KEY` presence:
 *
 * - key set        → the real `PrintfulProvider` (any environment);
 * - no key, dev/test → the deterministic `MockProvider` — the CI default and dev
 *   fallback, so the whole flow is testable with no key and no network;
 * - no key, production → `null`: fulfillment is genuinely not configured, which
 *   the submission service surfaces as `FulfillmentNotConfiguredError`.
 *
 * The prod/non-prod split is deliberate: the mock must never silently "fulfill" a
 * real paid order in production, but a missing key must also never block boot
 * (the `RESEND_API_KEY` posture — optional, validated at use, not at boot). The
 * caller decides what a `null` means for its flow; here it is always the
 * not-configured signal.
 */
export function getFulfillmentProvider(): FulfillmentProvider | null {
  if (env.PRINTFUL_API_KEY) {
    return (printfulSingleton ??= new PrintfulProvider());
  }
  if (env.NODE_ENV !== "production") {
    return (mockSingleton ??= new MockProvider());
  }
  return null;
}
