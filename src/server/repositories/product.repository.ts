import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import type { ProductInput } from "@/lib/validators/catalog";
import {
  DuplicateSkuError,
  SlugTakenError,
  VariantInUseError,
} from "@/server/catalog.errors";

/**
 * Data-access for products. Every method is scoped by `tenantId` so a store
 * can only ever touch its own catalog. Services call repositories; routes and
 * pages call services — never Prisma directly. Prisma unique-constraint
 * failures are the repository's to translate, so the Prisma import stays here.
 */

/** Translate a Prisma unique-constraint failure into a typed catalog error;
 *  rethrow anything else untouched. Always throws (never returns). */
function mapWriteError(err: unknown): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    const target = String(
      (err.meta as { target?: unknown } | undefined)?.target ?? "",
    );
    if (target.includes("slug")) throw new SlugTakenError();
    if (target.includes("sku")) throw new DuplicateSkuError();
  }
  throw err;
}

/** Parameters for the tenant-scoped catalog search (#105). `page` is 1-based;
 *  `pageSize` bounds the rows returned. `query` is the raw shopper input, passed
 *  straight to `websearch_to_tsquery` (which tolerates any junk without throwing);
 *  the calling boundary still zod-validates `page`/`pageSize` as positive ints. */
export type SearchProductsParams = {
  tenantId: string;
  query: string;
  page: number;
  pageSize: number;
};

/** A single ranked hit: a product with its variants — the same shape the
 *  storefront listing (`listActiveByTenant`) returns, so results reuse the same
 *  card and `availableUnits`. Typed via `Prisma.ProductGetPayload` (a static
 *  helper), never `ReturnType<typeof productRepository.…>`, which would collapse
 *  the whole repo object to `any` (TS7022/TS2456 — see the analytics repo note). */
export type ProductSearchHit = Prisma.ProductGetPayload<{
  include: { variants: true };
}>;

/** One page of ranked search hits (rank order preserved) plus `total` — the count
 *  of all matches for the same scope, for the caller's page math. */
export type ProductSearchPage = {
  products: ProductSearchHit[];
  total: number;
};

export const productRepository = {
  listActiveByTenant(tenantId: string) {
    return prisma.product.findMany({
      where: { tenantId, status: "ACTIVE" },
      include: { variants: true },
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Full-text catalog search for the storefront — tenant-scoped and ACTIVE-only,
   * ranked by relevance, offset-paginated. Runs over the `searchVector` generated
   * column (title weighted A, description B) through its GIN index, so a title
   * hit outranks a description-only one.
   *
   * Injection-safe by construction: every value is bound through a tagged-template
   * `$queryRaw` (never `$queryRawUnsafe`), and `websearch_to_tsquery` reads the raw
   * shopper `query` leniently — unbalanced quotes, bare operators and other junk
   * yield an empty match, never an error. An empty/whitespace query short-circuits
   * to an empty page (no term, no results), sparing a round-trip.
   *
   * The ranked-id read and the `count(*)::int` read are batched into one
   * `$transaction` (a single round-trip; `::int` returns a JS number, not a
   * bigint). Hydration is a second `findMany(id in rankedIds)` — tenant-scoped
   * again (golden rule 1) — re-ordered in JS to the rank sequence, since an
   * `IN (…)` does not preserve order. Each hit carries its variants so the caller
   * derives `available = stock - reserved` exactly as the rest of the storefront
   * does (`availableUnits`). `page`/`pageSize` are floored defensively (never a
   * negative offset, `take` never < 1); the boundary still zod-validates them.
   */
  async searchActiveByTenant({
    tenantId,
    query,
    page,
    pageSize,
  }: SearchProductsParams): Promise<ProductSearchPage> {
    if (!query.trim()) return { products: [], total: 0 };

    const take = Math.max(1, pageSize);
    const offset = Math.max(0, (page - 1) * pageSize);

    // Ranked ids + total match count in one round-trip. Tagged templates only —
    // every `${}` is a bound parameter, so the raw `query` can't inject SQL and a
    // malformed one is interpreted, never fatal. `status::text = 'ACTIVE'` casts
    // the enum for the raw comparison (mirrors membership.repository).
    const [ranked, [{ count: total }]] = await prisma.$transaction([
      prisma.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "Product"
        WHERE "tenantId" = ${tenantId}
          AND "status"::text = 'ACTIVE'
          AND "searchVector" @@ websearch_to_tsquery('english', ${query})
        ORDER BY
          ts_rank("searchVector", websearch_to_tsquery('english', ${query})) DESC,
          "createdAt" DESC,
          "id" DESC
        LIMIT ${take} OFFSET ${offset}
      `,
      prisma.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM "Product"
        WHERE "tenantId" = ${tenantId}
          AND "status"::text = 'ACTIVE'
          AND "searchVector" @@ websearch_to_tsquery('english', ${query})
      `,
    ]);

    const rankedIds = ranked.map((row) => row.id);
    if (rankedIds.length === 0) return { products: [], total };

    // Hydrate the page. Tenant-scoped again (defence in depth — the ids are
    // already this tenant's) so no catalog read escapes the tenant boundary.
    const rows = await prisma.product.findMany({
      where: { id: { in: rankedIds }, tenantId },
      include: { variants: true },
    });

    // `IN (…)` returns rows in an arbitrary order; restore the rank sequence.
    const byId = new Map(rows.map((product) => [product.id, product]));
    const products = rankedIds
      .map((id) => byId.get(id))
      .filter((product): product is ProductSearchHit => product !== undefined);

    return { products, total };
  },

  /** Admin listing: every status (incl. DRAFT/ARCHIVED), newest edits first. */
  listAllByTenant(tenantId: string) {
    return prisma.product.findMany({
      where: { tenantId },
      include: { variants: { orderBy: { createdAt: "asc" } } },
      orderBy: { updatedAt: "desc" },
    });
  },

  findBySlug(tenantId: string, slug: string) {
    return prisma.product.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
      include: { variants: true },
    });
  },

  /**
   * Single product for the admin editor. Uses `findFirst` so the tenant scope
   * is part of the WHERE — an id belonging to another tenant resolves to null
   * rather than leaking a row.
   */
  findByIdForTenant(tenantId: string, id: string) {
    return prisma.product.findFirst({
      where: { id, tenantId },
      include: {
        variants: {
          orderBy: { createdAt: "asc" },
          // `_count.orderItems` powers the editor's per-variant delete guard: a
          // variant that already appears in an order can't be removed, so the
          // form disables its Remove button up front instead of failing on save.
          include: { _count: { select: { orderItems: true } } },
        },
      },
    });
  },

  /**
   * Read variants by id, scoped to the tenant through the product relation
   * (`ProductVariant` has no `tenantId` of its own). Powers the cart/checkout
   * re-pricing: a foreign or unknown id simply doesn't come back. Includes the
   * minimal parent-product fields the caller needs to price the line and to drop
   * a variant whose product is no longer purchasable.
   */
  findVariantsForTenant(tenantId: string, ids: string[]) {
    return prisma.productVariant.findMany({
      where: { id: { in: ids }, product: { tenantId } },
      include: {
        product: {
          select: { id: true, title: true, slug: true, status: true },
        },
      },
    });
  },

  /** Create a product and its variants in one atomic write. */
  async createWithVariants(tenantId: string, input: ProductInput) {
    try {
      return await prisma.product.create({
        data: {
          tenantId,
          title: input.title,
          slug: input.slug,
          description: input.description ?? null,
          status: input.status,
          variants: {
            create: input.variants.map((v) => ({
              sku: v.sku,
              name: v.name,
              priceCents: v.priceCents,
              stock: v.stock,
            })),
          },
        },
        include: { variants: { orderBy: { createdAt: "asc" } } },
      });
    } catch (err) {
      mapWriteError(err);
    }
  },

  /**
   * Update a product and reconcile its variants (create added / update kept /
   * delete removed) in a single transaction. Returns null if the product isn't
   * owned by the tenant. The ownership gate runs first and every subsequent
   * write is scoped to the verified product id, so nothing can escape the
   * tenant boundary — even a tampered variant id resolves to zero rows.
   */
  async updateWithVariants(tenantId: string, id: string, input: ProductInput) {
    const kept = input.variants.filter(
      (v): v is ProductInput["variants"][number] & { id: string } =>
        Boolean(v.id),
    );
    const keptIds = kept.map((v) => v.id);

    try {
      return await prisma.$transaction(
        async (tx) => {
          const owned = await tx.product.findFirst({
            where: { id, tenantId },
            select: { id: true },
          });
          if (!owned) return null;

          await tx.product.update({
            where: { id },
            data: {
              title: input.title,
              slug: input.slug,
              description: input.description ?? null,
              status: input.status,
            },
          });

          // Refuse to remove a variant that already appears in an order:
          // `OrderItem.variant` is onDelete:Restrict, so the delete below would
          // otherwise fail with P2003 (mapped as a race backstop in mapWriteError).
          // This pre-check runs in the same transaction and names the offending
          // SKUs, so the admin gets a clear, field-level error — not a generic 500.
          const removedInUse = await tx.productVariant.findMany({
            where: {
              productId: id,
              ...(keptIds.length ? { id: { notIn: keptIds } } : {}),
              orderItems: { some: {} },
            },
            select: { sku: true },
            orderBy: { createdAt: "asc" },
          });
          if (removedInUse.length) {
            throw new VariantInUseError(removedInUse.map((v) => v.sku));
          }

          // Delete the variants the admin removed. An empty `keptIds` means every
          // existing variant was replaced, so the filter drops them all; only
          // order-free variants reach here since the guard above rejected the rest.
          await tx.productVariant.deleteMany({
            where: {
              productId: id,
              ...(keptIds.length ? { id: { notIn: keptIds } } : {}),
            },
          });

          // Two-phase update of kept variants: park every SKU to a transient,
          // collision-proof value first, so an admin swapping or rotating SKUs
          // between existing variants can't trip @@unique([productId, sku])
          // mid-update. zod already proved the final set is unique.
          for (const v of kept) {
            await tx.productVariant.updateMany({
              where: { id: v.id, productId: id },
              data: { sku: `__tmp_${v.id}` },
            });
          }
          for (const v of kept) {
            // updateMany (not update) keeps the write scoped to this product: a
            // stale or foreign id matches zero rows instead of touching it.
            await tx.productVariant.updateMany({
              where: { id: v.id, productId: id },
              data: {
                sku: v.sku,
                name: v.name,
                priceCents: v.priceCents,
                stock: v.stock,
              },
            });
          }

          const added = input.variants.filter((v) => !v.id);
          if (added.length) {
            await tx.productVariant.createMany({
              data: added.map((v) => ({
                productId: id,
                sku: v.sku,
                name: v.name,
                priceCents: v.priceCents,
                stock: v.stock,
              })),
            });
          }

          return tx.product.findUnique({
            where: { id },
            include: { variants: { orderBy: { createdAt: "asc" } } },
          });
        },
        // Ownership check + product update + in-use pre-check + deleteMany + 2×N
        // guarded SKU updateMany + createMany + findUnique run sequentially in this
        // interactive transaction; lift Prisma's default 5s cap so a many-variant
        // edit on a high-latency managed Postgres can't roll back with P2028
        // part-way through. Kept at 15s for consistency with the order path
        // (`order.repository.markPaidByPaymentIntent`).
        { timeout: 15_000 },
      );
    } catch (err) {
      // Backstop for the pre-check above: if an order lands on a to-be-removed
      // variant in the race between that check and the delete, Postgres refuses
      // the delete (`OrderItem.variant` is onDelete:Restrict) and Prisma raises
      // P2003. Only this delete path can hit a variant FK restriction, so the
      // mapping is scoped here rather than in the shared unique-constraint mapper.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2003"
      ) {
        throw new VariantInUseError();
      }
      mapWriteError(err);
    }
  },

  /** Soft-remove: flip status to ARCHIVED. Returns the number of rows changed
   * (0 = not found / not this tenant's). */
  async archive(tenantId: string, id: string) {
    const { count } = await prisma.product.updateMany({
      where: { id, tenantId },
      data: { status: "ARCHIVED" },
    });
    return count;
  },
};
