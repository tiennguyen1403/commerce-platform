"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProductImageFrame } from "../product-image";
import type { ViewerSlide } from "./product-lightbox";

/**
 * The image fields the gallery needs — a deliberately minimal shape (not the full
 * Prisma row or DTO) so no `tenantId`/`key`/timestamps cross to the client bundle.
 * `width`/`height` are the intrinsic pixel size already stored on `ProductImage`
 * (nullable there); they only size the viewer's slides — a display-only growth of
 * this client shape recorded in `docs/milestones/M7-storefront-v2/GOAL.md` →
 * Exceptions 2. No query widened for it.
 */
export type GalleryImage = {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
};

/**
 * Stamped on `<html>` while the fullscreen viewer is open. The mobile buy bar
 * (M7-04) hides itself on it — with `display: none`, never a transform — so it
 * can't float over the viewer's scrim while the page is scroll-locked (research
 * Risk #8): e.g. `[[data-viewer-open]_&]:hidden`. Import this only from client
 * modules: a Server Component importing a `"use client"` module gets a client
 * reference, not the string.
 */
export const VIEWER_OPEN_ATTR = "data-viewer-open";

// The viewer and its library live in their own chunk, fetched the first time a
// shopper opens it — never part of the PDP's initial JS or CSS. `ssr: false` is
// legal only because this is a Client Component (research §B); the page itself
// must never import the viewer.
const ProductLightbox = dynamic(() => import("./product-lightbox"), {
  ssr: false,
});

// The cover fills the PDP's 7fr column (M7-04's split: 644px at the 1152px
// container, ~58vw between the `md` breakpoint and that cap) and the full width
// below `md`; the rail thumbs are that column over six-to-eight cells.
const COVER_SIZES = "(min-width: 1200px) 644px, (min-width: 768px) 58vw, 100vw";
const THUMB_SIZES = "(min-width: 1200px) 112px, 10vw";

const overlayButton =
  "bg-background/90 text-foreground ring-foreground/10 hover:bg-background focus-visible:ring-ring/50 inline-flex items-center justify-center rounded-full ring-1 backdrop-blur-sm transition-colors outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50";

function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * PDP gallery — "gallery B" of the frozen PDP v2 canvas: one 4:5 cover with
 * round prev/next arrows, an expand button and a `k / N` counter, a thumbnail
 * rail beneath it from `md` up, and a swipeable track with dots below `md`. A
 * click or tap on the cover — or the expand button — opens the fullscreen viewer.
 *
 * One DOM, not two: the cover *is* a CSS scroll-snap track holding every image,
 * so the same markup swipes on a phone, scrolls with a trackpad, and is driven
 * by the arrows, thumbs and dots everywhere (no carousel library — research §D).
 * Only the active slide is exposed to assistive tech (`aria-hidden` on the rest,
 * per the APG carousel pattern), which also keeps `getByRole("img")` strict-mode
 * safe: a one-image product renders exactly one product-named `<img>` here.
 *
 * Client-side because of that interactivity; the caller renders this only for a
 * product that HAS images (an image-less product gets a static, server-rendered
 * placeholder instead), so `images` is non-empty. Exactly one image — the first
 * — is `preload`ed (the page's LCP); the rest lazy-load.
 */
export function ProductGallery({
  images,
  productTitle,
}: {
  images: GalleryImage[];
  productTitle: string;
}) {
  const count = images.length;
  const many = count > 1;
  const [active, setActive] = useState(0);
  const [viewer, setViewer] = useState({
    // Mounted on first open and kept mounted (closed) afterwards, so the close
    // animation can play out; never mounted before that.
    mounted: false,
    open: false,
    index: 0,
  });

  const trackRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  // The slide a programmatic scroll is travelling to, or `null` while the shopper
  // is in control of the track (a swipe, a drag, the wheel).
  const targetRef = useRef<number | null>(null);
  const activeRef = useRef(0);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  /**
   * Show slide `index` by scrolling the track to it. Finite, like the swipe it
   * mirrors and the viewer: the arrows disable at either end instead of wrapping.
   */
  const goTo = useCallback(
    (index: number, { instant = false } = {}) => {
      const next = Math.min(count - 1, Math.max(0, index));
      setActive(next);
      const track = trackRef.current;
      if (!track) return;
      targetRef.current = next;
      track.scrollTo({
        left: next * track.clientWidth,
        behavior: instant || prefersReducedMotion() ? "instant" : "smooth",
      });
    },
    [count],
  );

  // Follow the track: the counter, dots and rail reflect whatever slide the
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
        // the rail doesn't flicker through the slides it passes.
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

  // Keep the active slide in the frame when the track changes width (a viewport
  // resize, the scrollbar padding the viewer's scroll lock adds).
  useEffect(() => {
    const track = trackRef.current;
    if (!track || !many || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      track.scrollTo({
        left: activeRef.current * track.clientWidth,
        behavior: "instant",
      });
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, [many]);

  // Expose the open viewer to the rest of the page (see VIEWER_OPEN_ATTR).
  useEffect(() => {
    if (!viewer.open) return;
    const root = document.documentElement;
    root.setAttribute(VIEWER_OPEN_ATTR, "");
    return () => root.removeAttribute(VIEWER_OPEN_ATTR);
  }, [viewer.open]);

  const openViewer = (index: number) =>
    setViewer({ mounted: true, open: true, index });
  const closeViewer = () => {
    setViewer((current) => ({ ...current, open: false }));
    // The library restores focus to the element focused before it opened, but a
    // cover *click* focuses nothing — so land on the expand button either way.
    expandRef.current?.focus({ preventScroll: true });
  };

  const slides = useMemo<ViewerSlide[]>(
    () =>
      images.map((image) => ({
        src: image.url,
        alt: image.altText ?? productTitle,
        width: image.width ?? undefined,
        height: image.height ?? undefined,
      })),
    [images, productTitle],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="border-border bg-muted relative aspect-4/5 overflow-hidden rounded-xl border">
        <div
          ref={trackRef}
          role="region"
          aria-roledescription="carousel"
          aria-label="Product images"
          className="absolute inset-0 flex snap-x snap-mandatory [scrollbar-width:none] overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden"
        >
          {images.map((image, index) => (
            <div
              key={image.id}
              role="group"
              aria-roledescription="slide"
              aria-label={`${index + 1} of ${count}`}
              aria-hidden={index === active ? undefined : true}
              // A pointer convenience; the expand button is the keyboard path.
              onClick={() => openViewer(index)}
              className="relative h-full w-full shrink-0 cursor-zoom-in snap-start"
            >
              <ProductImageFrame
                image={image}
                productTitle={productTitle}
                sizes={COVER_SIZES}
                preload={index === 0}
              />
            </div>
          ))}
        </div>

        {many ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              disabled={active === 0}
              onClick={() => goTo(active - 1)}
              className={cn(
                overlayButton,
                "absolute top-1/2 left-3 hidden size-9 -translate-y-1/2 md:inline-flex",
              )}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next image"
              disabled={active === count - 1}
              onClick={() => goTo(active + 1)}
              className={cn(
                overlayButton,
                "absolute top-1/2 right-3 hidden size-9 -translate-y-1/2 md:inline-flex",
              )}
            >
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </>
        ) : null}

        <button
          ref={expandRef}
          type="button"
          aria-label="Open fullscreen viewer"
          onClick={() => openViewer(active)}
          className={cn(overlayButton, "absolute top-3 right-3 size-8")}
        >
          <Maximize2 className="size-4" aria-hidden />
        </button>

        {many ? (
          <div className="bg-background/90 text-foreground ring-foreground/10 pointer-events-none absolute bottom-3 left-3 inline-flex h-5 items-center rounded-full px-2 text-xs font-medium tabular-nums ring-1 backdrop-blur-sm">
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              Image {active + 1} of {count}
            </span>
            <span aria-hidden>
              {active + 1} / {count}
            </span>
          </div>
        ) : null}
      </div>

      {many ? (
        <>
          {/* Thumbnail rail (md and up). `max(6, N)` columns: two to six images
              share a six-column row, seven or eight get a column each — the admin
              cap of eight (MAX_IMAGES_PER_PRODUCT) keeps it one row. */}
          <ul
            className="hidden gap-2 md:grid"
            style={{
              gridTemplateColumns: `repeat(${Math.max(6, count)}, minmax(0, 1fr))`,
            }}
          >
            {images.map((image, index) => {
              const isActive = index === active;
              return (
                <li key={image.id}>
                  <button
                    type="button"
                    onClick={() => goTo(index)}
                    aria-label={`Show image ${index + 1}`}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "bg-muted focus-visible:ring-ring/50 relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border transition-colors focus-visible:ring-3 focus-visible:outline-none",
                      isActive
                        ? "border-foreground"
                        : "border-border hover:border-foreground/40",
                    )}
                  >
                    <ProductImageFrame
                      image={image}
                      productTitle={productTitle}
                      sizes={THUMB_SIZES}
                    />
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Dots (below md): the same labels as the rail — only one of the two
              is ever displayed, so assistive tech sees a single set. */}
          <div className="flex justify-center md:hidden">
            {images.map((image, index) => {
              const isActive = index === active;
              return (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => goTo(index)}
                  aria-label={`Show image ${index + 1}`}
                  aria-current={isActive ? "true" : undefined}
                  className="focus-visible:ring-ring/50 flex size-6 items-center justify-center rounded-full outline-none focus-visible:ring-3"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full transition-colors",
                      isActive ? "bg-foreground" : "bg-foreground/25",
                    )}
                  />
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      {viewer.mounted ? (
        <ProductLightbox
          open={viewer.open}
          index={viewer.index}
          slides={slides}
          onClose={closeViewer}
          onView={(index) => goTo(index, { instant: true })}
        />
      ) : null}
    </div>
  );
}
