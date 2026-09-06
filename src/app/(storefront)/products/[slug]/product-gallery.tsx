"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ProductImageFrame } from "../product-image";

/** The image fields the gallery needs — a deliberately minimal shape (not the full
 *  Prisma row or DTO) so no `tenantId`/`key`/timestamps cross to the client bundle. */
type GalleryImage = { id: string; url: string; altText: string | null };

/**
 * PDP image gallery: a large square main image with a thumbnail rail beneath it
 * (shown only when there's more than one image). Client-side because selecting a
 * thumb swaps the main image — the one piece of interactivity in the gallery. The
 * caller renders this only for a product that HAS images (an image-less product
 * gets a static, server-rendered placeholder instead), so `images` is non-empty.
 */
export function ProductGallery({
  images,
  productTitle,
}: {
  images: GalleryImage[];
  productTitle: string;
}) {
  const [activeId, setActiveId] = useState(images[0].id);
  // Guard against an id that isn't in the set (defensive) — fall back to the first.
  const active = images.find((image) => image.id === activeId) ?? images[0];

  return (
    <div className="flex flex-col gap-4">
      <div className="border-border bg-muted relative flex aspect-square items-center justify-center overflow-hidden rounded-xl border">
        <ProductImageFrame
          image={active}
          productTitle={productTitle}
          sizes="(min-width: 768px) 45vw, 100vw"
          preload
        />
      </div>

      {images.length > 1 ? (
        <ul className="grid grid-cols-5 gap-2 sm:grid-cols-6">
          {images.map((image, index) => {
            const isActive = image.id === active.id;
            return (
              <li key={image.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(image.id)}
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
                    sizes="(min-width: 640px) 16vw, 20vw"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
