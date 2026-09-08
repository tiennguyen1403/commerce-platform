import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImageProps } from "next/image";
import {
  ProductGallery,
  VIEWER_OPEN_ATTR,
  type GalleryImage,
} from "./product-gallery";
import type { ProductLightboxProps } from "./product-lightbox";

/**
 * `ProductGallery` unit tests.
 *
 * Two module boundaries are stubbed, both because the real thing needs
 * machinery jsdom doesn't have (the same reason `AccountMenu`'s test stubs
 * the Base UI dropdown primitives — see that file's doc comment):
 *  - `next/image` calls Next's (sharp-backed) image optimizer. Swapped for a
 *    plain `<img>` that forwards the DOM-valid props (`src`/`alt`/`sizes`)
 *    and records every call via `imagePropsSpy`, so the "only slide 0 is
 *    `preload`ed" contract can be asserted directly on the props Next would
 *    have received.
 *  - `next/dynamic` is how the gallery lazy-loads `ProductLightbox` — and,
 *    with it, `yet-another-react-lightbox`'s CSS. Mocked wholesale (per
 *    `dynamic`'s actual call shape below) to a tiny stub that records its
 *    props via `lightboxPropsSpy` and renders two buttons wired to the
 *    `onClose`/`onView(2)` props it received, so the viewer's *contract*
 *    (mount-on-open-only, `open`/`index`/`slides`, close/view callbacks) is
 *    exercised through real DOM events without importing the real library.
 *
 * Three jsdom gaps the component itself works around are mirrored here:
 * `Element.prototype.scrollTo` isn't implemented (stubbed once below, on the
 * prototype, and asserted on), `window.matchMedia` is absent by default (only
 * the reduced-motion test defines it — every other test therefore also
 * proves the component's `typeof window.matchMedia === "function"` guard
 * doesn't throw), and `ResizeObserver` is absent (the component's own
 * `typeof ResizeObserver === "undefined"` guard is what lets every test
 * mount without it; not exercised directly).
 *
 * `getByRole(..., { name })` matches the element's *exact* computed
 * accessible name (verified against `@testing-library/dom`'s `matches()`,
 * not the fuzzy/substring matcher some other queries use), so every fixture
 * image below gets distinct alt text to keep assertions unambiguous. Two
 * duplication quirks recur through these tests:
 *  - The thumbnail rail (`md`+) and the dots row (below `md`) render the
 *    *same* `aria-label`s ("Show image N") — only one is ever visible via
 *    Tailwind's `hidden`/`md:hidden`, which jsdom doesn't apply, so both
 *    copies exist in the tree; every rail/dot assertion uses
 *    `getAllByRole`/expects length 2.
 *  - Only the active slide is exposed to the accessibility tree (the rest
 *    are `aria-hidden`, which `getByRole` excludes by default but
 *    `getByText` does not — the `k / N` counter is itself `aria-hidden`,
 *    decorative next to a `sr-only` live region, so it's queried by text).
 *    A slide's *rail thumbnail* is therefore always role-queryable, but its
 *    *cover* `<img>` only joins the query results while that slide is
 *    active — an inactive image's cover and rail thumbnail share identical
 *    alt text (both render the same `image`), so only the rail copy shows up.
 */

const { imagePropsSpy } = vi.hoisted(() => ({
  imagePropsSpy: vi.fn<(props: ImageProps) => void>(),
}));

vi.mock("next/image", () => ({
  default: (props: ImageProps) => {
    imagePropsSpy(props);
    return (
      // The next/image mock: forwards only DOM-valid props (`src`/`alt`/
      // `sizes`); `unoptimized`/`fill`/`preload` are dropped since a plain
      // `<img>` doesn't understand them. The real `next/image` is never
      // rendered in this file.
      // eslint-disable-next-line @next/next/no-img-element -- this *is* the next/image mock
      <img
        src={typeof props.src === "string" ? props.src : ""}
        alt={props.alt}
        sizes={props.sizes}
      />
    );
  },
}));

const { lightboxPropsSpy, LightboxStub } = vi.hoisted(() => {
  const lightboxPropsSpy = vi.fn<(props: ProductLightboxProps) => void>();
  const LightboxStub = (props: ProductLightboxProps) => {
    lightboxPropsSpy(props);
    return (
      <div data-testid="lightbox" data-open={String(props.open)}>
        <button type="button" onClick={props.onClose}>
          stub-close
        </button>
        <button type="button" onClick={() => props.onView(2)}>
          stub-view-2
        </button>
      </div>
    );
  };
  return { lightboxPropsSpy, LightboxStub };
});

// The gallery calls `dynamic(() => import("./product-lightbox"), { ssr:
// false })`; both arguments are irrelevant to the mock, which always returns
// the stub — so the real module (and its CSS side-effect imports) is never
// touched by this file.
vi.mock("next/dynamic", () => ({
  default: () => LightboxStub,
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

const soloImage: GalleryImage[] = [
  {
    id: "solo-1",
    url: "/seed/solo.jpg",
    altText: null,
    width: 900,
    height: 1125,
  },
];

const threeImages: GalleryImage[] = [
  {
    id: "img-1",
    url: "/seed/front.jpg",
    altText: "Front view",
    width: 800,
    height: 1000,
  },
  {
    id: "img-2",
    url: "/seed/back.jpg",
    altText: "Back view",
    width: 800,
    height: 1000,
  },
  {
    id: "img-3",
    url: "/seed/side.jpg",
    altText: null,
    width: null,
    height: null,
  },
];
const THREE_IMAGES_TITLE = "Classic Tee";

describe("ProductGallery", () => {
  describe("a single image", () => {
    it("renders exactly one accessible image (alt falling back to the product title), the fullscreen button, and none of the multi-image controls", () => {
      render(<ProductGallery images={soloImage} productTitle="Solo Product" />);

      // altText is null on the fixture, so the fallback to `productTitle` is
      // what gives the sole cover image its accessible name — and, per the
      // component's doc comment, it's the *only* `<img>` in the tree.
      expect(
        screen.getByRole("img", { name: "Solo Product" }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole("img")).toHaveLength(1);

      expect(
        screen.queryByRole("button", { name: "Previous image" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Next image" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/^\d+ \/ \d+$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Image \d+ of \d+$/)).not.toBeInTheDocument();
      expect(
        screen.queryAllByRole("button", { name: "Show image 1" }),
      ).toHaveLength(0);

      expect(
        screen.getByRole("button", { name: "Open fullscreen viewer" }),
      ).toBeInTheDocument();
    });
  });

  describe("multiple images", () => {
    it("exposes both arrows, the k / N counter with its sr-only live-region twin, and rail+dot thumbnails current only on the active slide", () => {
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      expect(
        screen.getByRole("button", { name: "Previous image" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Next image" }),
      ).toBeInTheDocument();

      // The visible counter is `aria-hidden` (decorative beside the live
      // region), so it has to be found by text, not role.
      expect(screen.getByText("1 / 3")).toBeInTheDocument();
      expect(screen.getByText("Image 1 of 3")).toBeInTheDocument();

      for (const n of [1, 2, 3]) {
        const buttons = screen.getAllByRole("button", {
          name: `Show image ${n}`,
        });
        // Rail (`md`+) and dots (below `md`) share the label; jsdom applies
        // no CSS, so both copies are always in the tree.
        expect(buttons).toHaveLength(2);
        for (const button of buttons) {
          if (n === 1) {
            expect(button).toHaveAttribute("aria-current", "true");
          } else {
            expect(button).not.toHaveAttribute("aria-current");
          }
        }
      }

      // Only slide 1 is active, so only its slide `<div>` is exposed to the
      // accessibility tree — the other two are `aria-hidden`, which
      // `getByRole` excludes. Image 1 therefore contributes both its cover
      // *and* its rail thumbnail (identical alt text, same `image`); images 2
      // and 3 contribute only their (always-visible) rail thumbnail.
      expect(screen.getAllByRole("img", { name: "Front view" })).toHaveLength(
        2,
      );
      expect(screen.getAllByRole("img", { name: "Back view" })).toHaveLength(1);
      expect(
        screen.getAllByRole("img", { name: THREE_IMAGES_TITLE }),
      ).toHaveLength(1);
      expect(screen.getAllByRole("img")).toHaveLength(4);
    });

    it("advances to the next slide on 'Next image': counter, aria-current (both copies), and a smooth scrollTo", () => {
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Next image" }));

      expect(screen.getByText("2 / 3")).toBeInTheDocument();
      expect(screen.getByText("Image 2 of 3")).toBeInTheDocument();
      for (const button of screen.getAllByRole("button", {
        name: "Show image 2",
      })) {
        expect(button).toHaveAttribute("aria-current", "true");
      }
      for (const button of screen.getAllByRole("button", {
        name: "Show image 1",
      })) {
        expect(button).not.toHaveAttribute("aria-current");
      }

      expect(scrollToMock).toHaveBeenCalledTimes(1);
      expect(scrollToMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth" }),
      );
    });

    it("disables 'Previous image' at the first slide and 'Next image' at the last slide; a disabled button is a no-op", () => {
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      const previous = screen.getByRole("button", { name: "Previous image" });
      const next = screen.getByRole("button", { name: "Next image" });

      expect(previous).toBeDisabled();
      expect(next).not.toBeDisabled();

      fireEvent.click(previous);
      expect(scrollToMock).not.toHaveBeenCalled();
      expect(screen.getByText("1 / 3")).toBeInTheDocument();

      fireEvent.click(next);
      fireEvent.click(next);
      expect(screen.getByText("3 / 3")).toBeInTheDocument();
      expect(next).toBeDisabled();
      expect(previous).not.toBeDisabled();
      expect(scrollToMock).toHaveBeenCalledTimes(2);

      fireEvent.click(next);
      expect(screen.getByText("3 / 3")).toBeInTheDocument();
      expect(scrollToMock).toHaveBeenCalledTimes(2);
    });

    it("jumps straight to the slide tapped in the thumbnail rail/dots", () => {
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      const [railThumb] = screen.getAllByRole("button", {
        name: "Show image 3",
      });
      fireEvent.click(railThumb);

      expect(screen.getByText("3 / 3")).toBeInTheDocument();
      for (const button of screen.getAllByRole("button", {
        name: "Show image 3",
      })) {
        expect(button).toHaveAttribute("aria-current", "true");
      }
      expect(scrollToMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "smooth" }),
      );
    });

    it("scrolls instantly instead of smoothly when the shopper prefers reduced motion", () => {
      const matchMediaMock = stubReducedMotion(true);
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Next image" }));

      expect(matchMediaMock).toHaveBeenCalledWith(
        "(prefers-reduced-motion: reduce)",
      );
      expect(scrollToMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: "instant" }),
      );
    });

    it("marks only the first image's <img> as preload", () => {
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      const calls = imagePropsSpy.mock.calls.map(([props]) => props);
      // 3 cover slides + 3 rail thumbnails = 6 `next/image` renders (the dots
      // row has no images).
      expect(calls).toHaveLength(6);

      const preloaded = calls.filter((props) => props.preload === true);
      expect(preloaded).toHaveLength(1);
      expect(preloaded[0]).toMatchObject({ src: threeImages[0].url });

      for (const props of calls) {
        if (props !== preloaded[0]) {
          expect(props.preload).toBeFalsy();
        }
      }
    });
  });

  describe("fullscreen viewer", () => {
    it("mounts the lightbox lazily, opens at the active slide with mapped slides, stamps VIEWER_OPEN_ATTR, and on close stays mounted + restores focus — onView re-syncs the gallery", () => {
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      expect(screen.queryByTestId("lightbox")).not.toBeInTheDocument();
      expect(document.documentElement).not.toHaveAttribute(VIEWER_OPEN_ATTR);

      // Move off the first slide before opening, so the viewer opening at a
      // non-zero index is actually exercised (not just coincidentally 0).
      fireEvent.click(screen.getByRole("button", { name: "Next image" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Open fullscreen viewer" }),
      );

      expect(screen.getByTestId("lightbox")).toBeInTheDocument();
      expect(document.documentElement).toHaveAttribute(VIEWER_OPEN_ATTR);

      const lastOpenCall = lightboxPropsSpy.mock.calls.at(-1)?.[0];
      expect(lastOpenCall).toMatchObject({ open: true, index: 1 });
      expect(lastOpenCall?.slides).toEqual([
        { src: "/seed/front.jpg", alt: "Front view", width: 800, height: 1000 },
        { src: "/seed/back.jpg", alt: "Back view", width: 800, height: 1000 },
        {
          src: "/seed/side.jpg",
          alt: THREE_IMAGES_TITLE,
          width: undefined,
          height: undefined,
        },
      ]);

      fireEvent.click(screen.getByRole("button", { name: "stub-close" }));

      // Stays mounted (so the library's own close animation can finish) but
      // closed, and the attribute + focus move together.
      expect(screen.getByTestId("lightbox")).toHaveAttribute(
        "data-open",
        "false",
      );
      expect(lightboxPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ open: false }),
      );
      expect(document.documentElement).not.toHaveAttribute(VIEWER_OPEN_ATTR);
      expect(
        screen.getByRole("button", { name: "Open fullscreen viewer" }),
      ).toHaveFocus();

      fireEvent.click(screen.getByRole("button", { name: "stub-view-2" }));

      expect(screen.getByText("3 / 3")).toBeInTheDocument();
      expect(scrollToMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ behavior: "instant" }),
      );
    });

    it("opens the viewer at the index of the cover slide that was clicked", () => {
      render(
        <ProductGallery
          images={threeImages}
          productTitle={THREE_IMAGES_TITLE}
        />,
      );

      // Slide 1 is the only one not `aria-hidden` (it's active), so it's the
      // only one `getByRole` (singular) can find.
      fireEvent.click(screen.getByRole("group", { name: "1 of 3" }));

      expect(screen.getByTestId("lightbox")).toBeInTheDocument();
      expect(lightboxPropsSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({ open: true, index: 0 }),
      );
    });
  });
});
