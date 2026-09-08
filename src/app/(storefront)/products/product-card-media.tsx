"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ProductImageFrame } from "./product-image";

/**
 * The image fields the card slider needs — the same deliberately minimal client
 * shape as the PDP gallery's `GalleryImage` (no `tenantId`/`key`/timestamps reach
 * the client bundle), minus the intrinsic size only the fullscreen viewer uses.
 */
export type CardImage = {
  id: string;
  url: string;
  altText: string | null;
};

// A card fills one grid column: a third of the 1152px container at `lg` (352px
// once the 24px gutters and two 24px gaps are taken), half at `sm`, the full
// width below.
const CARD_SIZES =
  "(min-width: 1200px) 352px, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw";

// The PDP gallery's overlay-control recipe (product-gallery.tsx), sized for a card.
const overlayButton =
  "bg-background/90 text-foreground ring-foreground/10 hover:bg-background focus-visible:ring-ring/50 absolute top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-full ring-1 backdrop-blur-sm transition-colors outline-none focus-visible:ring-3 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-background/90";

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * A product card's media well plus its link — the card's one client island.
 *
 * The link wraps the image and the card body (`children`: title, price, meta —
 * rendered by the Server Component card and passed through), exactly the
 * link-wraps-image anatomy `e2e/product-images.spec.ts` keys on. With more than
 * one image the well is a CSS scroll-snap track over all of them (swipe on touch,
 * trackpad anywhere), and prev / next arrows appear on hover or focus for
 * fine pointers — `pointer-coarse:hidden`, so a phone never gets an invisible
 * button between a tap and the link. Interactive controls are invalid inside an
 * `<a>`, so the arrows, the dots and the live-region counter sit *beside* the
 * link as siblings in an overlay that mirrors the square well. The dots are
 * real "Show image N" buttons (the touch / assistive-tech path, as on the PDP)
 * but `tabIndex={-1}`: eight of them on each of a dozen cards would bury the
 * grid in tab stops, and the arrows already cover the keyboard.
 *
 * Only the active slide is exposed to assistive tech (`aria-hidden` on the
 * rest, per the APG carousel pattern): every slide's alt falls back to the
 * product title, so with N images the link would otherwise contain N `<img>`
 * sharing one accessible name — and `getByRole("img", { name })` inside the
 * link must stay unique. A single image renders no arrows, dots or counter (the
 * PDP rule); no image renders the placeholder icon. `preload` marks the first
 * image only — the caller sets it on the grid's first card — so a page keeps
 * exactly one LCP candidate; every other slide lazy-loads.
 */
export function ProductCardMedia({
  href,
  images,
  productTitle,
  preload = false,
  soldOut = false,
  children,
}: {
  href: string;
  images: CardImage[];
  productTitle: string;
  /** Mark the first image as the page's LCP preload (the grid's first card). */
  preload?: boolean;
  soldOut?: boolean;
  /** The card body (title, price, meta) — rendered inside the link, after the image. */
  children: ReactNode;
}) {
  const count = images.length;
  const many = count > 1;
  const [active, setActive] = useState(0);
  // Rendered index: `active` clamped to the current image list, so an image
  // list that shrinks while the card stays mounted (a Server Action re-render
  // after an admin removed a photo — the grid keys cards by product id) can't
  // leave every slide `aria-hidden` with no dot lit until the next interaction.
  const current = Math.min(active, Math.max(0, count - 1));

  const trackRef = useRef<HTMLDivElement>(null);
  // The slide a programmatic scroll is travelling to, or `null` while the shopper
  // is in control of the track (a swipe, a drag, the wheel).
  const targetRef = useRef<number | null>(null);
  const currentRef = useRef(0);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  /** Show slide `index` by scrolling the track to it. Finite: the arrows disable
   *  at either end instead of wrapping, like the PDP gallery. */
  const goTo = useCallback(
    (index: number) => {
      const next = Math.min(count - 1, Math.max(0, index));
      setActive(next);
      const track = trackRef.current;
      if (!track) return;
      const left = next * track.clientWidth;
      // Already there: no scroll event will follow, so don't arm a hold that
      // nothing releases.
      targetRef.current = Math.abs(track.scrollLeft - left) > 1 ? next : null;
      track.scrollTo({
        left,
        behavior: prefersReducedMotion() ? "instant" : "smooth",
      });
    },
    [count],
  );

  // Follow the track: the dots and the counter reflect whatever slide the
  // shopper swiped or scrolled to.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || !many) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const width = track.clientWidth;
      if (!width) return;
      const position = track.scrollLeft / width;
      const target = targetRef.current;
      if (target !== null) {
        // A programmatic scroll is still travelling: hold the state on its
        // destination (set eagerly in `goTo`) until the track lands there, so
        // the dots don't flicker through the slides it passes.
        if (Math.abs(position - target) > 0.02) return;
        targetRef.current = null;
      }
      setActive(Math.min(count - 1, Math.max(0, Math.round(position))));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    // A touch, drag or wheel takes control back from a programmatic scroll.
    const release = () => {
      targetRef.current = null;
    };
    track.addEventListener("scroll", onScroll, { passive: true });
    track.addEventListener("pointerdown", release, { passive: true });
    track.addEventListener("wheel", release, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      track.removeEventListener("scroll", onScroll);
      track.removeEventListener("pointerdown", release);
      track.removeEventListener("wheel", release);
    };
  }, [count, many]);

  // Keep the active slide in the frame when the card changes width (a viewport
  // resize, a column-count change at a breakpoint).
  useEffect(() => {
    const track = trackRef.current;
    if (!track || !many || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      track.scrollTo({
        left: currentRef.current * track.clientWidth,
        behavior: "instant",
      });
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, [many]);

  return (
    // `group/media`: the arrows reveal on hover / focus-within of the whole card
    // area, not just the well; `relative` anchors the control overlay.
    <div className="group/media relative">
      <Link href={href} className="block focus-visible:outline-none">
        <div className="bg-muted relative aspect-square">
          {count === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <ProductImageFrame
                image={undefined}
                productTitle={productTitle}
                sizes={CARD_SIZES}
                iconClassName="size-10"
              />
            </div>
          ) : (
            // `tabIndex={-1}`: Chrome makes a scrollable container keyboard-
            // focusable, which would add a tab stop per card; the arrows are the
            // keyboard path. No carousel roles inside the link — they would
            // pollute its accessible name; the counter lives with the controls.
            <div
              ref={trackRef}
              tabIndex={-1}
              className="absolute inset-0 flex snap-x snap-mandatory [scrollbar-width:none] overflow-x-auto overscroll-x-contain outline-none [&::-webkit-scrollbar]:hidden"
            >
              {images.map((image, index) => (
                <div
                  key={image.id}
                  aria-hidden={index === current ? undefined : true}
                  className="relative h-full w-full shrink-0 snap-start"
                >
                  <ProductImageFrame
                    image={image}
                    productTitle={productTitle}
                    sizes={CARD_SIZES}
                    preload={preload && index === 0}
                  />
                </div>
              ))}
            </div>
          )}
          {soldOut ? (
            <Badge variant="secondary" className="absolute top-3 left-3">
              Sold out
            </Badge>
          ) : null}
        </div>
        {children}
      </Link>

      {many ? (
        // Mirrors the square well; clicks fall through to the link everywhere
        // but on the controls.
        <div
          role="group"
          aria-label={`${productTitle} images`}
          className="pointer-events-none absolute inset-x-0 top-0 aspect-square"
        >
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            Image {current + 1} of {count}
          </span>
          {/* `aria-disabled`, not `disabled`: an arrow that reaches its end while
              focused must keep the focus rather than drop it on <body>. The
              reveal — opacity AND pointer events — sits on this wrapper so an
              invisible arrow can never take a click meant for the link (a fine
              pointer with no hover) and so it can't fight the arrows' own
              `aria-disabled:opacity-50`. */}
          <div className="opacity-0 group-focus-within/media:pointer-events-auto group-focus-within/media:opacity-100 group-hover/media:pointer-events-auto group-hover/media:opacity-100 motion-safe:transition-opacity pointer-coarse:hidden">
            <button
              type="button"
              aria-label="Previous image"
              aria-disabled={current === 0 || undefined}
              onClick={() => {
                if (current > 0) goTo(current - 1);
              }}
              className={cn(overlayButton, "left-3")}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next image"
              aria-disabled={current === count - 1 || undefined}
              onClick={() => {
                if (current < count - 1) goTo(current + 1);
              }}
              className={cn(overlayButton, "right-3")}
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
          {/* Dots: one per image, on a pill so they read on any photo, light or
              dark — the same "Show image N" controls as the PDP's dots, out of
              the tab order (see the component note). */}
          <div className="bg-background/90 ring-foreground/10 pointer-events-auto absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center rounded-full px-1 ring-1 backdrop-blur-sm">
            {images.map((image, index) => {
              const isActive = index === current;
              return (
                <button
                  key={image.id}
                  type="button"
                  tabIndex={-1}
                  aria-label={`Show image ${index + 1}`}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => goTo(index)}
                  className="focus-visible:ring-ring/50 flex size-5 items-center justify-center rounded-full outline-none focus-visible:ring-3"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full transition-colors",
                      isActive ? "bg-foreground" : "bg-foreground/35",
                    )}
                  />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
