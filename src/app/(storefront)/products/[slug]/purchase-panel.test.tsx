import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { formatMoney } from "@/lib/utils";
import { LOW_STOCK_THRESHOLD } from "@/config/constants";
import { MAX_CART_QTY } from "@/lib/cart";
import type { CartActionResult } from "@/lib/cart";
import { PurchasePanel, type PurchaseVariant } from "./purchase-panel";

/**
 * `PurchasePanel` unit tests.
 *
 * One module boundary is stubbed: `addToCartAction` is a Server Action
 * (`"use server"`) whose real implementation resolves the storefront tenant and
 * reads/writes through Prisma-backed repositories — machinery this file has no
 * business standing up. It's replaced with a single hoisted `vi.fn()` (per the
 * task brief) so each test can script its resolution — `mockResolvedValueOnce`
 * for the success/error paths, a manually-settled `Promise` for the pending
 * ("Adding…") one — and assert exactly what the component passed it. `next/link`
 * is deliberately *not* mocked: outside a Next router context its
 * `useContext(AppRouterContext)` reads `null`, and every branch in `next/link`
 * that reads `router` already guards on that (verified against the installed
 * `next` package), so it renders a plain, inert `<a href="/cart">` — exactly
 * what the assertions below need.
 *
 * Two `@testing-library/dom` query quirks recur below, both because
 * `getByText`'s default matcher (`getNodeText`) only concatenates an element's
 * *direct* text-node children, not descendant elements' text (verified against
 * the installed `@testing-library/dom`):
 *  - The sold-out CTA's own label and the sold-out `Badge` both render the
 *    literal text "Sold out" as a direct child, so an unscoped `getByText`
 *    matches both — the badge is disambiguated with `{ selector: "span" }`
 *    (the CTA is a `<button>`).
 *  - The "Added to cart" status line nests a real `<Link>` ("View cart"), so
 *    its own direct text is only "Added to cart ·" — asserted via
 *    `toHaveTextContent` (which reads the full, nested `textContent`) plus
 *    `within(status).getByRole("link", …)`, not a combined `getByText`.
 *
 * The Base UI `Button`s in the stepper pass `focusableWhenDisabled` (verified
 * against the installed `@base-ui/react`'s `useFocusableWhenDisabled`): at a
 * bound they render `aria-disabled="true"` and keep `tabIndex={0}` — the real
 * `disabled` attribute is never set, so `toBeDisabled()`/`toBeEnabled()` never
 * move for them. The primary and bar CTAs do the same while an add is in flight
 * ("Adding…" is `aria-disabled`, still focusable); only the sold-out CTA and the
 * sold-out variant chips use the ordinary `disabled` attribute, where
 * `toBeDisabled()` applies normally.
 *
 * The mobile buy bar has no `IntersectionObserver`: a single frame-throttled
 * `scroll`/`resize` listener reads the CTA row's own
 * `getBoundingClientRect().bottom` (also checked once, synchronously, on
 * mount) and `document.documentElement.scrollHeight`. jsdom performs no layout,
 * so by default every rect is all-zero (`bottom <= 0` already reads as
 * "scrolled past") and `scrollHeight` is `0` (reads as "no room to clear the
 * footer") — so showing the bar needs only a `scrollHeight` stub, and proving
 * the "still below the fold" / "clears near the end" branches needs an
 * explicit `getBoundingClientRect`/`scrollY` stub plus a dispatched `scroll`
 * event. jsdom's `requestAnimationFrame` (present — this environment is
 * constructed `pretendToBeVisual`, verified against the installed `jsdom` and
 * Vitest's bundled jsdom environment) runs on a real ~16ms timer, so those two
 * tests `await waitFor(...)` rather than asserting synchronously.
 * `window.matchMedia` is absent by default in this jsdom (see the sibling
 * gallery test's doc comment); every *non*-bar test below re-proves the
 * effect's `typeof window.matchMedia !== "function"` guard doesn't throw.
 */

const { addToCartActionMock } = vi.hoisted(() => ({
  addToCartActionMock:
    vi.fn<(variantId: string, qty?: number) => Promise<CartActionResult>>(),
}));

vi.mock("@/app/(storefront)/cart/actions", () => ({
  addToCartAction: addToCartActionMock,
}));

const CURRENCY = "usd";

const wellStocked: PurchaseVariant = {
  id: "variant-well-stocked",
  name: "One size",
  priceCents: 4200,
  available: 20,
};

const atLowStockThreshold: PurchaseVariant = {
  id: "variant-low-stock",
  name: "One size",
  priceCents: 1999,
  available: LOW_STOCK_THRESHOLD,
};

const soldOutSolo: PurchaseVariant = {
  id: "variant-sold-out-solo",
  name: "One size",
  priceCents: 1999,
  available: 0,
};

const soldOutSmall: PurchaseVariant = {
  id: "variant-small-sold-out",
  name: "Small",
  priceCents: 3000,
  available: 0,
};

const inStockLarge: PurchaseVariant = {
  id: "variant-large-in-stock",
  name: "Large",
  priceCents: 5000,
  available: 20,
};

const soldOutMedium: PurchaseVariant = {
  id: "variant-medium-sold-out",
  name: "Medium",
  priceCents: 3500,
  available: 0,
};

const roomyVariant: PurchaseVariant = {
  id: "variant-roomy",
  name: "Small",
  priceCents: 2500,
  available: 20,
};

const scarceVariant: PurchaseVariant = {
  id: "variant-scarce",
  name: "Large",
  priceCents: 3500,
  available: 2,
};

const tightVariant: PurchaseVariant = {
  id: "variant-tight",
  name: "One size",
  priceCents: 1500,
  available: 3,
};

const abundantVariant: PurchaseVariant = {
  id: "variant-abundant",
  name: "One size",
  priceCents: 1200,
  available: 150,
};

const variantA: PurchaseVariant = {
  id: "variant-a",
  name: "Small",
  priceCents: 2000,
  available: 20,
};

const variantB: PurchaseVariant = {
  id: "variant-b",
  name: "Large",
  priceCents: 3300,
  available: 20,
};

/** Stubs `window.matchMedia` so the buy-bar effect's `BELOW_MD` query reports
 *  `matches` — mirrors `product-gallery.test.tsx`'s `stubReducedMotion`. */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

/** `Element#scrollHeight` is a read-only, jsdom-computed (always `0`) getter —
 *  shadowed here with a configurable own property so it can be deleted again
 *  in `afterEach`. Safe to delete-and-fall-back: it's a regular (non
 *  `[Replaceable]`) IDL attribute, defined once on `Element.prototype`, not
 *  per instance (verified against the installed `jsdom`). */
function stubScrollHeight(value: number) {
  Object.defineProperty(document.documentElement, "scrollHeight", {
    value,
    configurable: true,
  });
}

// Unlike `scrollHeight` above, `window.scrollY` is a WebIDL `[Replaceable]`
// attribute — jsdom defines it as an own, getter-only property *on this one
// `window` instance* (`Object.defineProperties(window, { scrollY:
// makeReplaceablePropertyDescriptor(...) })`, verified against the installed
// `jsdom`), not on a shared prototype. Vitest constructs the jsdom `window`
// once per test *file*, so `Reflect.deleteProperty(window, "scrollY")` in
// `afterEach` would delete jsdom's real getter outright — with nothing to
// fall back to — the first time *any* test in this file touches it, silently
// turning every later `window.scrollY` read into `undefined` (so
// `scrollHeight - (scrollY + innerHeight)` becomes `NaN`, and the buy bar can
// never show again for the rest of the file). Captured once, before any test
// runs, and restored (not deleted) below.
const originalScrollYDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "scrollY",
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(document.documentElement, "scrollHeight");
  if (originalScrollYDescriptor) {
    Object.defineProperty(window, "scrollY", originalScrollYDescriptor);
  } else {
    Reflect.deleteProperty(window, "scrollY");
  }
});

describe("PurchasePanel", () => {
  describe("price and stock", () => {
    it("shows the price, an 'In stock' line, no variant chips for a single variant, a default qty of 1 with Decrease aria-disabled at the floor, an enabled CTA, and no mobile buy bar in a plain jsdom environment", () => {
      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      expect(
        screen.getByText(formatMoney(wellStocked.priceCents, CURRENCY)),
      ).toBeInTheDocument();
      expect(screen.getByText("In stock")).toBeInTheDocument();

      // A single variant renders its name as plain text, not a radiogroup.
      expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
      expect(screen.getByText(wellStocked.name)).toBeInTheDocument();

      const qtyGroup = screen.getByRole("group", { name: "Quantity" });
      expect(within(qtyGroup).getByText("1")).toBeInTheDocument();
      const decrease = screen.getByRole("button", {
        name: "Decrease quantity",
      });
      const increase = screen.getByRole("button", {
        name: "Increase quantity",
      });
      expect(decrease).toHaveAttribute("aria-disabled", "true");
      expect(decrease).toBeEnabled(); // focusableWhenDisabled: no native `disabled`
      expect(decrease.tabIndex).toBe(0);
      expect(increase).not.toHaveAttribute("aria-disabled", "true");

      expect(screen.getByRole("button", { name: "Add to cart" })).toBeEnabled();

      // No second ("bar") CTA — the effect's `matchMedia` guard bails cleanly.
      expect(
        screen.getAllByRole("button", { name: "Add to cart" }),
      ).toHaveLength(1);
    });

    it("shows the low-stock count at the threshold boundary, and a disabled 'Sold out' badge/CTA with still-focusable (aria-disabled, not html-disabled) stepper buttons when unavailable", () => {
      render(
        <PurchasePanel
          variants={[atLowStockThreshold]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      expect(
        screen.getByText(`Only ${LOW_STOCK_THRESHOLD} left`),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add to cart" })).toBeEnabled();

      cleanup();

      render(
        <PurchasePanel
          variants={[soldOutSolo]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      expect(
        screen.getByText("Sold out", { selector: "span" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sold out" })).toBeDisabled();

      for (const name of ["Decrease quantity", "Increase quantity"]) {
        const button = screen.getByRole("button", { name });
        expect(button).toHaveAttribute("aria-disabled", "true");
        expect(button).toBeEnabled();
      }
    });
  });

  describe("variant selection", () => {
    it("renders a radiogroup only with multiple variants, disables the sold-out chip, defaults to the first in-stock variant (skipping a sold-out first entry), and falls back to the first variant when the whole product is sold out", () => {
      render(
        <PurchasePanel
          variants={[soldOutSmall, inStockLarge]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      expect(
        screen.getByRole("radiogroup", { name: "Variant" }),
      ).toBeInTheDocument();
      const small = screen.getByRole("radio", { name: "Small" });
      const large = screen.getByRole("radio", { name: "Large" });
      expect(small).toBeDisabled();
      expect(small).toHaveAttribute("aria-checked", "false");
      expect(large).toHaveAttribute("aria-checked", "true");
      expect(
        screen.getByText(formatMoney(inStockLarge.priceCents, CURRENCY)),
      ).toBeInTheDocument();

      cleanup();

      render(
        <PurchasePanel
          variants={[soldOutSmall, soldOutMedium]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      expect(screen.getByRole("radio", { name: "Small" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      expect(screen.getByRole("button", { name: "Sold out" })).toBeDisabled();
    });

    it("clicking a variant chip switches the selection, updates price/stock, and clamps an already-larger quantity to the new ceiling instead of resetting it", () => {
      render(
        <PurchasePanel
          variants={[roomyVariant, scarceVariant]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      const increase = screen.getByRole("button", {
        name: "Increase quantity",
      });
      fireEvent.click(increase);
      fireEvent.click(increase);
      fireEvent.click(increase); // qty 4 — well under roomyVariant's 20
      const qtyGroup = screen.getByRole("group", { name: "Quantity" });
      expect(within(qtyGroup).getByText("4")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: "Large" }));

      expect(
        screen.getByText(formatMoney(scarceVariant.priceCents, CURRENCY)),
      ).toBeInTheDocument();
      expect(screen.getByText("Only 2 left")).toBeInTheDocument();
      // Clamped to the new ceiling (2), not reset to 1.
      expect(within(qtyGroup).getByText("2")).toBeInTheDocument();
      expect(increase).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("quantity stepper", () => {
    it("increments and decrements within [1, available], marking a bound button aria-disabled — never the disabled attribute — while it stays focusable, and no-ops past the bound", () => {
      render(
        <PurchasePanel
          variants={[tightVariant]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      const decrease = screen.getByRole("button", {
        name: "Decrease quantity",
      });
      const increase = screen.getByRole("button", {
        name: "Increase quantity",
      });
      const qtyGroup = screen.getByRole("group", { name: "Quantity" });
      const readout = () => within(qtyGroup).getByText(/^\d+$/);

      expect(readout()).toHaveTextContent("1");
      expect(decrease).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(decrease); // no-op at the floor
      expect(readout()).toHaveTextContent("1");

      fireEvent.click(increase);
      expect(readout()).toHaveTextContent("2");
      expect(decrease).not.toHaveAttribute("aria-disabled", "true");

      fireEvent.click(increase);
      expect(readout()).toHaveTextContent("3"); // available = 3, the ceiling
      expect(increase).toHaveAttribute("aria-disabled", "true");
      expect(increase).toBeEnabled();
      expect(increase.tabIndex).toBe(0);

      fireEvent.click(increase); // no-op at the ceiling
      expect(readout()).toHaveTextContent("3");

      fireEvent.click(decrease);
      fireEvent.click(decrease);
      expect(readout()).toHaveTextContent("1");
      expect(decrease).toHaveAttribute("aria-disabled", "true");
    });

    it("clamps the stepper's ceiling to MAX_CART_QTY even when the variant has far more stock", () => {
      render(
        <PurchasePanel
          variants={[abundantVariant]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      const increase = screen.getByRole("button", {
        name: "Increase quantity",
      });
      const qtyGroup = screen.getByRole("group", { name: "Quantity" });

      for (let i = 1; i < MAX_CART_QTY; i++) {
        fireEvent.click(increase);
      }

      expect(
        within(qtyGroup).getByText(String(MAX_CART_QTY)),
      ).toBeInTheDocument();
      expect(increase).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(increase); // no-op past MAX_CART_QTY (150 available)
      expect(
        within(qtyGroup).getByText(String(MAX_CART_QTY)),
      ).toBeInTheDocument();
    });
  });

  describe("status messages", () => {
    it("clears a previous error message when the shopper changes the quantity or switches variant", async () => {
      addToCartActionMock.mockResolvedValueOnce({ ok: false, error: "nope" });
      render(
        <PurchasePanel
          variants={[variantA, variantB]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
      await screen.findByRole("alert");
      // `status` (which the alert renders off) and `isPending` (which the
      // stepper's `disabled` also reads) settle in *two* separate renders —
      // under load, `findByRole("alert")` can resolve on the render where
      // `status` has already flipped to "error" but `isPending` hasn't yet
      // flipped back to `false`, i.e. mid-"Adding…", so the very next click
      // has to wait for the CTA to fully settle first or it's a no-op.
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Add to cart" }),
        ).toBeEnabled();
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Increase quantity" }),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      addToCartActionMock.mockResolvedValueOnce({ ok: false, error: "nope" });
      fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
      await screen.findByRole("alert");
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Add to cart" }),
        ).toBeEnabled();
      });

      fireEvent.click(screen.getByRole("radio", { name: "Large" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.getByText(formatMoney(variantB.priceCents, CURRENCY)),
      ).toBeInTheDocument();
    });
  });

  describe("add to cart", () => {
    it("calls the action with the selected variant id and the current quantity, then shows a success line linking to /cart", async () => {
      addToCartActionMock.mockResolvedValueOnce({ ok: true, count: 3 });
      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      const increase = screen.getByRole("button", {
        name: "Increase quantity",
      });
      fireEvent.click(increase);
      fireEvent.click(increase); // qty 3

      fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));

      const status = await screen.findByRole("status");
      expect(addToCartActionMock).toHaveBeenCalledExactlyOnceWith(
        wellStocked.id,
        3,
      );
      expect(status).toHaveTextContent("Added to cart");
      expect(
        within(status).getByRole("link", { name: "View cart" }),
      ).toHaveAttribute("href", "/cart");
      expect(
        await screen.findByRole("button", { name: "Add to cart" }),
      ).toBeEnabled();
    });

    it("shows an 'Adding…' pending label while the transition is in flight, then settles into the success line", async () => {
      let resolveAction!: (result: CartActionResult) => void;
      addToCartActionMock.mockImplementationOnce(
        () =>
          new Promise<CartActionResult>((resolve) => {
            resolveAction = resolve;
          }),
      );
      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));

      const pendingCta = await screen.findByRole("button", {
        name: "Adding…",
      });
      // Pending is `aria-disabled` (focus stays on the button), not `disabled`.
      expect(pendingCta).toHaveAttribute("aria-disabled", "true");
      expect(pendingCta).toBeEnabled();
      // The stepper is disabled too while a request is in flight.
      expect(
        screen.getByRole("button", { name: "Increase quantity" }),
      ).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        resolveAction({ ok: true, count: 1 });
      });

      const settledCta = await screen.findByRole("button", {
        name: "Add to cart",
      });
      expect(settledCta).toBeEnabled();
      expect(settledCta).not.toHaveAttribute("aria-disabled", "true");
      expect(screen.getByRole("status")).toHaveTextContent("Added to cart");
    });

    it("shows an alert line when the action reports failure, and the CTA is clickable again afterwards", async () => {
      addToCartActionMock.mockResolvedValueOnce({
        ok: false,
        error: "This item is no longer available.",
      });
      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "Couldn't add to cart. Please try again.",
      );
      expect(
        await screen.findByRole("button", { name: "Add to cart" }),
      ).toBeEnabled();
    });
  });

  describe("mobile buy bar", () => {
    it("never shows the bar on desktop (matches: false), even with a tall document and a dispatched scroll", () => {
      stubMatchMedia(false);
      stubScrollHeight(3000);

      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      expect(
        screen.getAllByRole("button", { name: "Add to cart" }),
      ).toHaveLength(1);

      window.dispatchEvent(new Event("scroll"));
      expect(
        screen.getAllByRole("button", { name: "Add to cart" }),
      ).toHaveLength(1);
    });

    it("shows the bar once mounted on phone with the document tall enough to clear the footer (jsdom's default zero rect already reads as 'scrolled past'), including the Qty suffix once quantity rises above 1", () => {
      stubMatchMedia(true);
      stubScrollHeight(3000);

      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );

      expect(
        screen.getAllByRole("button", { name: "Add to cart" }),
      ).toHaveLength(2);
      expect(screen.getByText("Aurora Tee")).toBeInTheDocument();
      const priceVariantLine = `${formatMoney(wellStocked.priceCents, CURRENCY)} · ${wellStocked.name}`;
      expect(screen.getByText(priceVariantLine)).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Increase quantity" }),
      );
      expect(
        screen.getByText(`${priceVariantLine} · Qty 2`),
      ).toBeInTheDocument();
    });

    it("hides the bar once the row's rect shows it's merely below the fold, not yet scrolled past", async () => {
      stubMatchMedia(true);
      stubScrollHeight(3000);

      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      // Baseline: visible on mount (see the previous test).
      expect(
        screen.getAllByRole("button", { name: "Add to cart" }),
      ).toHaveLength(2);

      const row = screen.getByRole("group", { name: "Quantity" })
        .parentElement as HTMLElement;
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 452,
        width: 343,
        height: 48,
        top: 452,
        right: 343,
        bottom: 500,
        left: 0,
        toJSON: () => ({}),
      });

      window.dispatchEvent(new Event("scroll"));

      await waitFor(() => {
        expect(
          screen.getAllByRole("button", { name: "Add to cart" }),
        ).toHaveLength(1);
      });
    });

    it("steps the bar aside within the last BUY_BAR_CLEARANCE (80) px of the document, even while the row stays scrolled past", async () => {
      stubMatchMedia(true);
      stubScrollHeight(3000);

      render(
        <PurchasePanel
          variants={[wellStocked]}
          currency={CURRENCY}
          productTitle="Aurora Tee"
        />,
      );
      expect(
        screen.getAllByRole("button", { name: "Add to cart" }),
      ).toHaveLength(2);

      // scrollHeight(3000) - (scrollY + innerHeight) = 40, under the 80px
      // clearance — computed off the live `innerHeight` rather than an assumed
      // jsdom default, so this doesn't silently stop testing anything if that
      // default ever changes.
      Object.defineProperty(window, "scrollY", {
        value: 3000 - window.innerHeight - 40,
        configurable: true,
      });
      window.dispatchEvent(new Event("scroll"));

      await waitFor(() => {
        expect(
          screen.getAllByRole("button", { name: "Add to cart" }),
        ).toHaveLength(1);
      });
    });
  });
});
