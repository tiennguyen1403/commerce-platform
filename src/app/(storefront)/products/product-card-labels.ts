import { LOW_STOCK_THRESHOLD } from "@/config/constants";
import { availableUnits } from "@/lib/inventory";
import { formatMoney } from "@/lib/utils";

/**
 * Pure label helpers for the product card (listing + search results). They read
 * the variants the listing query already loads — nothing here widens a query —
 * and are kept out of the card component so they can be unit-tested without
 * rendering. Card copy in one place: the card and its skeleton/tests agree.
 */

/** The variant fields the card's labels read — a subset of the Prisma row, so a
 *  test fixture doesn't have to satisfy the whole `ProductVariant` type. */
export type CardVariant = {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
  reserved: number;
  createdAt: Date;
};

/**
 * Variants in the order the admin entered them: `createdAt` ascending, ties
 * broken by `id`. The listing query returns variants in heap order (no
 * `orderBy` — and adding one would widen the query), which drifts as rows are
 * updated: the seed's hoodie already comes back Medium, Large, Small. Variants
 * created in one write share a millisecond, so `createdAt` alone can't order
 * them; Prisma's cuid ids carry a per-process counter, so they sort in creation
 * order and settle the tie. The admin editor orders by `createdAt` as well.
 */
export function inEntryOrder<T extends Pick<CardVariant, "id" | "createdAt">>(
  variants: readonly T[],
): T[] {
  return [...variants].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** Entry price for a card: a flat price when every variant matches, otherwise
 *  "From <cheapest>" so the grid stays scannable without a full range. */
export function priceLabel(
  variants: readonly Pick<CardVariant, "priceCents">[],
  currency: string,
): string {
  if (variants.length === 0) return "—";
  const prices = variants.map((v) => v.priceCents);
  const min = Math.min(...prices);
  return prices.every((p) => p === min)
    ? formatMoney(min, currency)
    : `From ${formatMoney(min, currency)}`;
}

/**
 * What the variants offer, so "From …" explains itself: the single variant's own
 * name ("One size", "12 oz") when there is one, else the count and the range of
 * names in entry order — "3 sizes · Small–Large". Variant names are the catalog's
 * one flat axis (no colour axis exists — see #248), which the seed and the admin
 * form use for sizes. Pass variants already in entry order (`inEntryOrder`).
 */
export function variantsLabel(
  variants: readonly Pick<CardVariant, "name">[],
): string | null {
  if (variants.length === 0) return null;
  if (variants.length === 1) return variants[0].name;
  const first = variants[0].name;
  const last = variants[variants.length - 1].name;
  const count = `${variants.length} sizes`;
  return first === last ? count : `${count} · ${first}–${last}`;
}

/**
 * A muted low-stock cue for the whole product — "Only N left" when its sellable
 * units across every variant are at or below `LOW_STOCK_THRESHOLD` (the admin
 * dashboard's threshold; the PDP applies it per selected variant). Sold out (0)
 * is the badge's job, so it returns null there too.
 */
export function lowStockLabel(
  variants: readonly Pick<CardVariant, "stock" | "reserved">[],
): string | null {
  const total = variants.reduce((sum, v) => sum + availableUnits(v), 0);
  return total > 0 && total <= LOW_STOCK_THRESHOLD
    ? `Only ${total} left`
    : null;
}
