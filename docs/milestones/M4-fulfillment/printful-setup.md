# Printful setup — operator prerequisite + manual smoke test

The `PrintfulProvider` adapter (`src/server/fulfillment/printful.ts`, M4 #138) is a thin
client over Printful's **v1 REST API**. The app never provisions a Printful account — that's
a one-time **operator prerequisite**, the same category as M3's wildcard-domain hosting. This
doc is what an operator does once to turn real fulfillment on, plus the free, no-charge smoke
test to verify the integration against a live account.

> Until `PRINTFUL_API_KEY` is set, the provider selector (`getFulfillmentProvider`) falls back
> to the deterministic **mock** in dev/test and returns **null** (not-configured) in
> production. CI never talks to Printful. Nothing below is required to build or test the app.

## Operator prerequisite (one-time)

1. **Create the one platform Printful store.** In the [Printful dashboard](https://www.printful.com/dashboard)
   → **Stores** → add a store. A **"Manual order platform / API"** store is the right type —
   this platform submits orders over the API, it doesn't sync a hosted storefront catalog.
   One store serves the whole app (provider config is per-platform, not per-tenant — per-store
   payouts need Stripe Connect, deferred; see `docs/ARCHITECTURE.md`).
2. **Generate a Private Token.** Store **Settings → API / Developers → Add token**. Create a
   **Store-level** token (scoped to this one store) — the adapter then needs only the
   `Authorization: Bearer <token>` header, no `X-PF-Store-Id`. Treat the token as a secret.
   - _(An account-level token spanning multiple stores would additionally require an
     `X-PF-Store-Id` header. We use a single store, so a store-level token is simpler.)_
3. **Set `PRINTFUL_API_KEY`.** Locally in `.env` (see `.env.example`); in production as an
   environment variable on the deployment. Optional, validated at use — a missing/blank value
   never blocks boot (the `RESEND_API_KEY` posture).
4. **Fund a payment method (production only).** A **confirmed** order (`?confirm=1`, what
   `createOrder` sends) charges the store owner's card and prints a real good. Add a funded
   payment method in the Printful billing settings before going live. The smoke test below
   uses **drafts** (`confirm=0`), which are free.
5. **Map your variants.** Each `ProductVariant` needs its `providerVariantId` set to a Printful
   **catalog `variant_id`** (an integer, e.g. `4011`) in the admin product form (#136). An
   unmapped variant fails the whole order to `FAILED` with a clear, admin-fixable error — it is
   never sent as a blank line. Find catalog variant ids via Printful's Catalog API or the
   product's page in the dashboard.

## Manual smoke test — a free `confirm=0` draft (no charge)

Printful has **no sandbox**. The safe way to verify the integration against a real account is a
**draft** order: `POST /orders` **without** `confirm=1` (i.e. `?confirm=0` or omitted) creates
an order that "does not trigger production or billing" — free, reversible, and it exercises the
exact auth, recipient shape, and response envelope the adapter depends on. Run it once against a
dev token when wiring up a new account, or when Printful changes its API.

Set your token, then create a draft (swap in a **real** catalog `variant_id`):

```bash
export PRINTFUL_API_KEY='<your store-level private token>'

# 1) Create a DRAFT order (confirm=0 → NOT charged, NOT produced).
curl -sS -X POST 'https://api.printful.com/orders?confirm=0' \
  -H "Authorization: Bearer $PRINTFUL_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "external_id": "smoke-test-1",
    "recipient": {
      "name": "Ada Lovelace",
      "address1": "1 Analytical Ave",
      "city": "San Francisco",
      "state_code": "CA",
      "country_code": "US",
      "zip": "94103"
    },
    "items": [{ "variant_id": 4011, "quantity": 1, "retail_price": "19.99" }],
    "retail_costs": { "currency": "USD" }
  }' | tee /tmp/printful-draft.json
```

A success comes back as `{ "code": 200, "result": { "id": <number>, "status": "draft", … } }`.
That confirms Bearer auth, the recipient mapping (`address1`/`state_code`/`country_code`/`zip`
— exactly what `toRecipient` in the adapter produces), the integer `variant_id`, the per-item
`retail_price` (#148) and the currency-only `retail_costs` (#157) — the exact payload the
adapter sends — and the `{ code, result }` envelope the adapter parses. Accepting the
**currency-only `retail_costs`** here is the one thing the v1 OpenAPI spec can't confirm for
us (it marks no `retail_costs` field required, but ships no worked example of a currency-only
object), so this draft is where you verify it before going live — swap `"USD"` for a
non-store-currency code (e.g. `"EUR"`) to also confirm a differing currency is accepted. A
validation problem comes back as an HTTP **400** with `{ "result": "<message>", "error": {
"reason", "message" } }` — the shape the adapter resolves to `status: "failed"`.

Then read it back (mirrors `getTracking`), using the returned id:

```bash
ORDER_ID=$(node -e "process.stdout.write(String(require('/tmp/printful-draft.json').result.id))")

curl -sS "https://api.printful.com/orders/$ORDER_ID" \
  -H "Authorization: Bearer $PRINTFUL_API_KEY"
```

Inspect `result.status` (one of `draft`, `inreview`, `pending`, `failed`, `canceled`,
`inprocess`, `onhold`, `partial`, `fulfilled`, `archived`) and `result.shipments[]`
(`carrier` / `tracking_number` / `tracking_url`) — the fields `getTracking` maps onto
`TrackingInfo`. A brand-new draft has no shipments yet, which the adapter handles (returns just
`status`).

Clean up (a draft can be deleted; a confirmed order cannot):

```bash
curl -sS -X DELETE "https://api.printful.com/orders/$ORDER_ID" \
  -H "Authorization: Bearer $PRINTFUL_API_KEY"
```

> **Never** run the create with `?confirm=1` for a smoke test — that submits the order for
> fulfillment and **charges** the account. `confirm=1` is what the real `createOrder` sends in
> production, where a Stripe payment has already been captured for the order.

## What the adapter does not do (by design)

- **`retail_costs`: the currency label only, not the aggregate cost breakdown.** Each line
  carries our retail price as Printful's optional per-item `retail_price` (a decimal string,
  e.g. `"19.99"`, formatted from the order item's integer `priceCents` — M4 **#148**), so the
  packing slip shows our prices instead of Printful's base price. The order also sends
  `retail_costs: { currency }` — the order's own currency, uppercased (e.g. `"EUR"`) — so
  those prices are framed in the **tenant's** currency instead of the single platform Printful
  store's default (M4 **#157**; the platform is multi-tenant with a per-tenant
  `Tenant.currency`, but one platform-level `PRINTFUL_API_KEY` account). It is the _only_
  currency lever the v1 API exposes — there is no per-order top-level `currency` field — and
  it sets the slip's **display label** only; Printful still bills the store owner in the
  store's own currency (the read-only `costs`). The other `retail_costs` fields (`subtotal` /
  `discount` / `shipping` / `tax`) are still deliberately not sent: the fulfillment input
  carries no shipping/tax breakdown, so a partial one would misstate the slip totals — and
  currency-only is safe precisely because it carries no total to misstate (the schema marks
  no `retail_costs` field required, and the "used only if _every_ item has a `retail_price`"
  gate is already met). Revisit — send the full breakdown — only if we want fully itemized
  customer-facing costs on the slip.
- **One shipment surfaced.** `TrackingInfo` carries a single tracking set, so a partial
  (multi-shipment) order surfaces the first shipment only.
- **Tracking is polled, not webhook-driven** (see `research.md` / `GOAL.md`).

## References

- `src/server/fulfillment/printful.ts` — the adapter (request/response mapping, error policy).
- `src/lib/env.ts` — `PRINTFUL_API_KEY` (optional, validated at use).
- `docs/milestones/M4-fulfillment/research.md` — provider evaluation + the v1 API findings.
- Printful v1 API: <https://developers.printful.com/docs/> · spec:
  <https://developers.printful.com/docs/openapi.json>
