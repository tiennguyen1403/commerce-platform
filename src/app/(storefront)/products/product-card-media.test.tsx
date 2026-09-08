import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ImageProps } from "next/image";
import { ProductCardMedia, type CardImage } from "./product-card-media";

/**
 * `ProductCardMedia` unit tests.
 *
 * One module boundary is stubbed, for the same reason as the sibling PDP
 * gallery test (`product-gallery.test.tsx`, the house pattern this file
 * follows): `next/image` calls Next's (sharp-backed) image optimizer, which
 * jsdom can't run. Swapped for a plain `<img>` that forwards the DOM-valid
 * props (`src`/`alt`/`sizes`) and records every call via `imagePropsSpy`, so
 * the "only the first slide is `preload`ed" contract can be asserted
 * directly on the props Next would have received.
 *
 * `next/link` is deliberately *not* mocked, for the reason
 * `purchase-panel.test.tsx` documents: outside a Next router context its
 * `useContext(AppRouterContext)` reads `null`, and every branch in
 * `next/link` that reads `router` already guards on that (verified against
 * the installed `next` package), so it renders a plain, inert `<a href="…">`
 * — exactly what the assertions below need. Exactly one `<a>` ever exists in
 * this component's tree, so most tests fetch it via the unqualified
 * `screen.getByRole("link")` rather than by name: a link's accessible name
 * folds in *every* descendant's contributed text, including an exposed
 * image's `alt`, so once an image is present the link's full name is a
 * combination the tests don't need to spell out. The one exception is the
 * zero-image test, where the link's only content is its `children`, so its
 * name is asserted directly.
 *
 * Two jsdom gaps the component itself works around are mirrored here (see
 * the gallery test's own doc comment for the fuller rationale):
 * `Element.prototype.scrollTo` isn't implemented (stubbed once, on the
 * prototype, below), and `window.matchMedia` is absent by default (only the
 * reduced-motion test defines it — every other test therefore also proves
 * the component's `typeof window.matchMedia === "function"` guard doesn't
 * throw). `ResizeObserver` is likewise absent and left unmocked — the
 * component's own `typeof ResizeObserver === "undefined"` guard is what lets
 * every test mount without it.
 *
 * Only the active slide is exposed to the accessibility tree (the rest are
 * `aria-hidden`, which `getByRole` excludes by default but `getByText` does
 * not): with more than one image, `getAllByRole("img")` therefore always has
 * length 1, no matter how many images the fixture carries, and the visible
 * "Image k of N" text is queried by text, not role.
 */

const { imagePropsSpy } = vi.hoisted(() => ({
  imagePropsSpy: vi.fn<(props: ImageProps) => void>(),
}));

vi.mock("next/image", () => ({
  default: (props: ImageProps) => {
    imagePropsSpy(props);
    return (
      // eslint-disable-next-line @next/next/no-img-element -- this *is* the next/image mock
      <img
        src={typeof props.src === "string" ? props.src : ""}
        alt={props.alt}
        sizes={props.sizes}
      />
    );
  },
}));

// Not implemented by jsdom (verified against the installed `jsdom` package);
// patched once, on the prototype, for every test in this file.
const scrollToMock = vi.fn();
Element.prototype.scrollTo = scrollToMock;

/** Stubs `window.matchMedia` for the one test that needs
 *  `prefers-reduced-motion: reduce` to report `matches`. */
function stubReducedMotion(matches: boolean) {
  const matchMediaMock = vi.fn().mockReturnValue({ matches });
  window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;
  return matchMediaMock;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // `window.matchMedia` is undefined by default in jsdom; only
  // `stubReducedMotion` defines it, so remove it again so every other test
  // keeps exercising the component's real (absent-matchMedia) guard.
  Reflect.deleteProperty(window, "matchMedia");
});

const threeImages: CardImage[] = [
  { id: "img-1", url: "/seed/front.jpg", altText: "Front view" },
  { id: "img-2", url: "/seed/back.jpg", altText: "Back view" },
  { id: "img-3", url: "/seed/side.jpg", altText: null },
];
const THREE_IMAGES_TITLE = "Classic Tee";

describe("ProductCardMedia", () => {
  describe("no images", () => {
    it("renders the link named by its children, with no image, arrows, live region, or group", () => {
      render(
        <ProductCardMedia
          href="/products/mug"
          images={[]}
          productTitle="Ceramic Mug"
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      const link = screen.getByRole("link", { name: "Card body" });
      expect(link).toHaveAttribute("href", "/products/mug");

      expect(screen.queryAllByRole("img")).toHaveLength(0);
      expect(
        screen.queryByRole("button", { name: "Previous image" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Next image" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/^Image \d+ of \d+$/)).not.toBeInTheDocument();
      expect(screen.queryByRole("group")).not.toBeInTheDocument();
    });
  });

  describe("one image", () => {
    it("renders exactly one accessible image, alt falling back to the product title, and none of the multi-image controls", () => {
      render(
        <ProductCardMedia
          href="/products/mug"
          images={[{ id: "img-1", url: "/seed/mug.jpg", altText: null }]}
          productTitle="Ceramic Mug"
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      const link = screen.getByRole("link");
      expect(
        within(link).getByRole("img", { name: "Ceramic Mug" }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole("img")).toHaveLength(1);

      expect(
        screen.queryByRole("button", { name: "Previous image" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Next image" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/^Image \d+ of \d+$/)).not.toBeInTheDocument();
      expect(screen.queryByRole("group")).not.toBeInTheDocument();
    });

    it("names the image by its altText when present, instead of the product title", () => {
      render(
        <ProductCardMedia
          href="/products/mug"
          images={[
            {
              id: "img-1",
              url: "/seed/mug.jpg",
              altText: "A blue ceramic mug",
            },
          ]}
          productTitle="Ceramic Mug"
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      expect(
        screen.getByRole("img", { name: "A blue ceramic mug" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("img", { name: "Ceramic Mug" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("multiple images", () => {
    it("exposes only the active slide's <img>, and puts the arrow/live-region overlay outside the link", () => {
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      // Only the first slide is exposed — the other two are `aria-hidden`.
      expect(screen.getAllByRole("img")).toHaveLength(1);
      expect(
        screen.getByRole("img", { name: "Front view" }),
      ).toBeInTheDocument();

      expect(
        screen.getByRole("group", { name: `${THREE_IMAGES_TITLE} images` }),
      ).toBeInTheDocument();

      // The arrows are siblings of the link, not nested inside it —
      // interactive controls are invalid inside an `<a>`.
      const link = screen.getByRole("link");
      expect(within(link).queryByRole("button")).not.toBeInTheDocument();

      const previous = screen.getByRole("button", { name: "Previous image" });
      const next = screen.getByRole("button", { name: "Next image" });
      expect(previous).toHaveAttribute("aria-disabled", "true");
      expect(next).not.toHaveAttribute("aria-disabled");

      expect(screen.getByText("Image 1 of 3")).toBeInTheDocument();
    });

    it("advances on 'Next image' with a smooth scrollTo, disables at the last slide where a further click is a no-op, and 'Previous image' works back", () => {
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      const previous = screen.getByRole("button", { name: "Previous image" });
      const next = screen.getByRole("button", { name: "Next image" });

      fireEvent.click(next);

      expect(screen.getByText("Image 2 of 3")).toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "Back view" }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole("img")).toHaveLength(1);
      expect(scrollToMock).toHaveBeenCalledTimes(1);
      expect(scrollToMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth" }),
      );

      fireEvent.click(next); // slide 3 of 3 — the last

      expect(screen.getByText("Image 3 of 3")).toBeInTheDocument();
      expect(next).toHaveAttribute("aria-disabled", "true");
      expect(scrollToMock).toHaveBeenCalledTimes(2);

      fireEvent.click(next); // already at the end: a no-op

      expect(screen.getByText("Image 3 of 3")).toBeInTheDocument();
      expect(scrollToMock).toHaveBeenCalledTimes(2);

      fireEvent.click(previous);

      expect(screen.getByText("Image 2 of 3")).toBeInTheDocument();
      expect(
        screen.getByRole("img", { name: "Back view" }),
      ).toBeInTheDocument();
      expect(scrollToMock).toHaveBeenCalledTimes(3);
    });

    it("makes a click on the disabled 'Previous image' arrow at the first slide a no-op", () => {
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      const previous = screen.getByRole("button", { name: "Previous image" });
      expect(previous).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(previous);

      expect(scrollToMock).not.toHaveBeenCalled();
      expect(screen.getByText("Image 1 of 3")).toBeInTheDocument();
    });

    it("scrolls instantly instead of smoothly when the shopper prefers reduced motion", () => {
      const matchMediaMock = stubReducedMotion(true);
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Next image" }));

      expect(matchMediaMock).toHaveBeenCalledWith(
        "(prefers-reduced-motion: reduce)",
      );
      expect(scrollToMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "instant" }),
      );
    });
  });

  describe("preload", () => {
    it("marks only the first image's next/image render as preload when the prop is set", () => {
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
          preload
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      const calls = imagePropsSpy.mock.calls.map(([props]) => props);
      // One `next/image` render per slide — every slide mounts (the track
      // needs all of them), only visibility toggles via `aria-hidden`.
      expect(calls).toHaveLength(3);

      const preloaded = calls.filter((props) => props.preload === true);
      expect(preloaded).toHaveLength(1);
      expect(preloaded[0]).toMatchObject({ src: threeImages[0].url });

      for (const props of calls) {
        if (props !== preloaded[0]) {
          expect(props.preload).toBeFalsy();
        }
      }
    });

    it("marks no image as preload when the prop is left at its default (false)", () => {
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      const calls = imagePropsSpy.mock.calls.map(([props]) => props);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((props) => !props.preload)).toBe(true);
    });
  });

  describe("soldOut", () => {
    it('renders "Sold out" inside the link when true, and omits it when false', () => {
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
          soldOut
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      const link = screen.getByRole("link");
      expect(within(link).getByText("Sold out")).toBeInTheDocument();

      cleanup();

      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        >
          <h2>Card body</h2>
        </ProductCardMedia>,
      );

      expect(screen.queryByText("Sold out")).not.toBeInTheDocument();
    });
  });

  describe("children", () => {
    it("renders the card body passed as children inside the link", () => {
      render(
        <ProductCardMedia
          href="/products/tee"
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        >
          <h2>Classic Tee — $19.99</h2>
        </ProductCardMedia>,
      );

      const link = screen.getByRole("link");
      expect(
        within(link).getByText("Classic Tee — $19.99"),
      ).toBeInTheDocument();
    });
  });
});
