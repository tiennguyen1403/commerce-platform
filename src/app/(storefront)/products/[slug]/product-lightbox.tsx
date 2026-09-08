"use client";

// The viewer library's stylesheet and the one plugin sheet it needs are imported
// from exactly this module (GOAL.md → Exceptions 2): it is loaded through
// `next/dynamic` from the gallery, so the PDP pays for the viewer's JS *and* CSS
// only once a shopper opens it. Both sheets are unlayered CSS, which under
// Tailwind v4's `@layer` setup outranks every utility on the same node — so the
// viewer is themed below through the library's `--yarl__*` custom properties and
// `styles` slots, never with Tailwind classes on its nodes (research Risk #6).
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import "./product-lightbox.css";

import { useEffect, useRef, useState } from "react";
import Lightbox, {
  useLightboxState,
  type ControllerRef,
  type Labels,
  type Render,
  type SlideImage,
  type SlotStyles,
} from "yet-another-react-lightbox";
import Slideshow from "yet-another-react-lightbox/plugins/slideshow";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { TENANT_THEME_SELECTOR } from "@/lib/theme";

/**
 * A viewer slide: the plain `{ src, alt, width, height }` the library renders as
 * a bare `<img>`. The slides bypass `next/image` on purpose: the Zoom plugin needs
 * a real `<img>` it can size from `width`/`height`. A root-relative URL (seed,
 * local mock) is already the PDP's `unoptimized` path (`isUnoptimizedImageSrc`);
 * a Blob `https://` URL simply loads the original — which is what a zoomable
 * fullscreen slide wants anyway.
 */
export type ViewerSlide = Pick<SlideImage, "src" | "alt" | "width" | "height">;

export type ProductLightboxProps = {
  open: boolean;
  /** The slide to open on. The gallery keeps it stable while the viewer is open. */
  index: number;
  slides: readonly ViewerSlide[];
  /** Called by the library once its close animation has finished. */
  onClose: () => void;
  /** Called whenever the viewer lands on a slide (including on open). */
  onView: (index: number) => void;
};

/**
 * The viewer's own neutrals. A photo viewer is a dark surface in *both* color
 * schemes, so these are the dark-scheme neutrals of `globals.css` written out as
 * literals (`--background` 0.145 / `--foreground` 0.985 / `--muted` 0.269) rather
 * than the scheme-flipping tokens, which would turn the scrim white in light mode.
 * The one live token is `--ring` (the thumbnails' focus ring): it carries the
 * tenant hue, and resolving it inside the portal is what proves the accent reaches
 * this overlay (#113, research Risk #4). Native `oklch()` passes straight through
 * — the library is not an iframe, unlike the Stripe Payment Element.
 */
const SCRIM = "oklch(0.145 0 0 / 0.94)";
const INK = "oklch(0.985 0 0)";
const INK_SOFT = "oklch(0.985 0 0 / 0.82)";
const INK_FAINT = "oklch(0.985 0 0 / 0.6)";
const INK_DIM = "oklch(0.985 0 0 / 0.4)";
const GLASS = "oklch(0.985 0 0 / 0.12)";
const GLASS_EDGE = "oklch(0.985 0 0 / 0.2)";
const WELL = "oklch(0.269 0 0)";

// The round, glass-filled prev/next buttons of the frozen canvas (44px: a 20px
// icon + 12px padding), inset from the edges instead of flush against them.
const NAV_BUTTON = {
  "--yarl__navigation_button_padding": "12px",
  "--yarl__button_background_color": GLASS,
  "--yarl__button_border": `1px solid ${GLASS_EDGE}`,
  borderRadius: 9999,
} as const;

const VIEWER_STYLES: SlotStyles = {
  root: {
    "--yarl__color_backdrop": SCRIM,
    "--yarl__color_button": INK_SOFT,
    "--yarl__color_button_active": INK,
    "--yarl__color_button_disabled": INK_DIM,
    // Flat controls on the scrim (the library's default adds a drop shadow).
    "--yarl__button_filter": "none",
    // Toolbar buttons are 40px: a 20px lucide icon + 10px padding.
    "--yarl__button_padding": "10px",
    "--yarl__icon_size": "20px",
    "--yarl__toolbar_padding": "8px",
    "--yarl__thumbnails_container_padding": "12px 16px 16px",
    "--yarl__thumbnails_thumbnail_gap": "8px",
    "--yarl__thumbnails_thumbnail_background": WELL,
    "--yarl__thumbnails_thumbnail_border_color": "transparent",
    "--yarl__thumbnails_thumbnail_active_border_color": INK,
    "--yarl__thumbnails_thumbnail_focus_box_shadow": `0 0 0 2px oklch(0.145 0 0), 0 0 0 4px var(--ring)`,
  },
  // Reserve the toolbar band (40px buttons + 8px padding each side) above the
  // image and the caption band below it, so a tall photo never sits under the
  // controls: the library subtracts the container's padding when it sizes slides.
  container: { paddingTop: 56, paddingBottom: 32 },
  navigationPrev: { ...NAV_BUTTON, left: 16 },
  navigationNext: { ...NAV_BUTTON, right: 16 },
};

/**
 * Accessible names, applied by the library as both `title` and `aria-label`.
 * Chosen not to substring-collide with any name the E2E suite queries (research
 * → Preserved E2E selectors; the M6-09 `getByLabel` trap).
 */
const LABELS: Labels = {
  Lightbox: "Image viewer",
  Previous: "Previous image",
  Next: "Next image",
  Close: "Close",
  "Zoom in": "Zoom in",
  "Zoom out": "Zoom out",
  Play: "Play slideshow",
  Pause: "Pause slideshow",
};

// lucide glyphs in place of the library's Material-style defaults (docs/DESIGN.md:
// lucide only). The library wraps each in its own 40px/44px button.
const ICONS: Render = {
  iconPrev: () => <ChevronLeft className="size-5" aria-hidden />,
  iconNext: () => <ChevronRight className="size-5" aria-hidden />,
  iconClose: () => <X className="size-5" aria-hidden />,
  iconZoomIn: () => <ZoomIn className="size-5" aria-hidden />,
  iconZoomOut: () => <ZoomOut className="size-5" aria-hidden />,
  iconSlideshowPlay: () => <Play className="size-5" aria-hidden />,
  iconSlideshowPause: () => <Pause className="size-5" aria-hidden />,
};

/**
 * The canvas's heads-up chrome, drawn over the controller: the `k / N` counter
 * with a zoom-level pill beside it (top-left, level with the toolbar), and the
 * caption + gesture hint line above the thumbnails. Decorative for assistive
 * tech: the library's carousel is already a polite live region announcing
 * "k of N", the current slide's `<img>` carries the alt, and the hints describe
 * pointer gestures — so the whole layer is `aria-hidden`, exactly like the
 * library's own Counter plugin (which this replaces so the pill can sit beside it).
 */
function ViewerHud({ zoom }: { zoom: number }) {
  const { currentSlide, currentIndex, slides } = useLightboxState();
  const zoomed = zoom > 1;
  return (
    <div aria-hidden className="pointer-events-none">
      <div
        className="absolute top-0 left-0 flex h-12 items-center gap-2 px-4 text-sm tabular-nums"
        style={{ color: INK_SOFT }}
      >
        {slides.length > 1 ? (
          <span>
            {currentIndex + 1} / {slides.length}
          </span>
        ) : null}
        {zoomed ? (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: GLASS, color: INK }}
          >
            {Math.round(zoom * 100)}%
          </span>
        ) : null}
      </div>
      <p
        className="absolute inset-x-0 bottom-2 truncate px-4 text-center text-xs"
        style={{ color: INK_FAINT }}
      >
        {currentSlide?.alt ? `${currentSlide.alt} · ` : null}
        <span className="pointer-coarse:hidden">
          {zoomed
            ? "Drag to pan · double-click to reset"
            : "Double-click or scroll to zoom"}
        </span>
        <span className="pointer-fine:hidden">
          Pinch to zoom · swipe for the next image
        </span>
      </p>
    </div>
  );
}

/**
 * The PDP's fullscreen image viewer — `yet-another-react-lightbox` with its Zoom,
 * Thumbnails and Slideshow plugins, themed to the frozen PDP v2 canvas
 * ("Viewer · fit / zoomed / mobile" boards). Default export so the gallery can
 * `next/dynamic` it; nothing else imports this module.
 *
 * What the library provides, verified in its source (`dist/index.js`): a
 * `role="dialog" aria-modal="true"` portal that stamps `inert` + `aria-hidden` on
 * every sibling of the portal node while open (so Tab can never reach the page
 * behind), focus moved into the viewer on open and restored on close, backdrop /
 * pull-down to close, arrows + keyboard + swipe, and a `prefers-reduced-motion`
 * gate on its fade, swipe and zoom animations. Two keyboard gaps are closed here
 * (see the effect below): Esc is dead while focus sits on the portal root or on
 * `<body>` (where Tab lands between the last control and the first), and Tab does
 * not wrap. The slideshow never autoplays; it only runs when the shopper presses
 * Play.
 *
 * Tenant accent (#113 / Risk #4): the portal mounts *inside* the storefront's
 * `[data-tenant-theme]` wrapper (`portal.root`) rather than on `<body>`, so the
 * store's tokens reach it by plain inheritance — no `TENANT_THEME_PORTAL_ATTR`
 * needed (the library's `portal.container` is typed as a weak
 * `HTMLAttributes<HTMLDivElement>`, which refuses a bare `data-*` key anyway) —
 * and the siblings the library inerts are exactly the header, main and footer.
 */
export default function ProductLightbox({
  open,
  index,
  slides,
  onClose,
  onView,
}: ProductLightboxProps) {
  const [zoom, setZoom] = useState(1);
  // A single image needs no prev/next, thumbnails or slideshow — only zoom.
  const single = slides.length <= 1;

  // Keyboard, document-wide while open. The library's own Escape handling lives
  // on the sensors of its controller and its thumbnails track, so a shopper whose
  // focus has moved to the portal root or past the last control onto `<body>`
  // would find Esc dead. So Esc closes from anywhere (the library's
  // `closeOnEscape` is off, keeping exactly one handler), and Tab / Shift+Tab
  // wrap inside the dialog instead of pausing on `<body>`, as the APG dialog
  // pattern asks. Only visible, enabled controls count (the thumbnail strip pads
  // itself with invisible placeholder buttons).
  const controllerRef = useRef<ControllerRef>(null);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        controllerRef.current?.close();
        return;
      }
      if (event.key !== "Tab") return;
      const root = document.querySelector('[role="dialog"][aria-modal="true"]');
      if (!root) return;
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
      if (controls.length === 0) return;
      // Focus on `<body>`, on the portal root or on the library's `tabIndex="-1"`
      // controller (where it lands on open) is "outside" the ring of controls, so
      // a first Shift+Tab reaches the last control instead of the browser chrome.
      const position = controls.indexOf(document.activeElement as HTMLElement);
      const outside = position === -1;
      if (
        event.shiftKey
          ? outside || position === 0
          : outside || position === controls.length - 1
      ) {
        event.preventDefault();
        (event.shiftKey ? controls[controls.length - 1] : controls[0]).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <Lightbox
      open={open}
      close={onClose}
      index={index}
      slides={slides}
      plugins={single ? [Zoom] : [Slideshow, Thumbnails, Zoom]}
      toolbar={{
        buttons: single ? ["zoom", "close"] : ["slideshow", "zoom", "close"],
      }}
      labels={LABELS}
      styles={VIEWER_STYLES}
      render={{
        ...ICONS,
        ...(single ? { buttonPrev: () => null, buttonNext: () => null } : null),
        controls: () => <ViewerHud zoom={zoom} />,
      }}
      // Finite, like the on-page gallery: the thumbnail strip would otherwise
      // repeat the set around the active slide (2 images → [2][1][2]). The strip
      // only draws `preload` neighbours on each side, so 7 (the admin cap of 8
      // images, minus the active one) shows every thumbnail of any product; the
      // library clamps it to N − 1, so a two-image product still mounts two.
      carousel={{ finite: true, preload: 7 }}
      controller={{
        ref: controllerRef,
        closeOnEscape: false,
        closeOnBackdropClick: true,
        closeOnPullDown: true,
      }}
      // `maxZoomPixelRatio` 2 lets a photo zoom to two image pixels per device
      // pixel, so a 1000px-wide shot still reaches ~2× on a 3× phone display.
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 2 }}
      slideshow={{ autoplay: false, delay: 4000 }}
      thumbnails={{
        position: "bottom",
        width: 56,
        height: 56,
        border: 2,
        borderRadius: 6,
        padding: 0,
        gap: 8,
        imageFit: "cover",
        vignette: false,
      }}
      portal={{ root: () => document.querySelector(TENANT_THEME_SELECTOR) }}
      on={{
        entering: () => setZoom(1),
        view: ({ index: viewed }) => onView(viewed),
        zoom: ({ zoom: level }) => setZoom(level),
      }}
    />
  );
}
