import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isUnoptimizedImageSrc } from "@/lib/validators/catalog";

/** The minimal shape needed to render an image — satisfied by both the Prisma
 *  `ProductImage` row (server reads) and the client-side gallery image. */
type RenderableImage = { url: string; altText: string | null };

/**
 * A product image in a fixed square frame (`fill` + `object-cover`, per
 * docs/DESIGN.md), or the lucide placeholder when the product has no image. Shared
 * by the card, the PDP gallery main image, and the thumbnail rail so the
 * `unoptimized` heuristic and the alt-text fallback live in exactly one place.
 *
 * `fill` (rather than the stored width/height) is deliberate: the frame owns the
 * aspect ratio, so there's no layout shift and the nullable stored dims aren't
 * needed to render. The parent MUST therefore be `position: relative` and size the
 * frame (e.g. `aspect-square`); `fill` positions the image absolutely within it.
 *
 * `preload` marks an LCP image (the first card in a grid, the PDP main image) — the
 * Next 16 replacement for the deprecated `priority` prop; everything else lazy-loads.
 */
export function ProductImageFrame({
  image,
  productTitle,
  sizes,
  preload = false,
  iconClassName,
}: {
  image: RenderableImage | null | undefined;
  productTitle: string;
  sizes: string;
  preload?: boolean;
  iconClassName?: string;
}) {
  if (!image) {
    return (
      <ImageIcon
        className={cn("text-muted-foreground/40", iconClassName)}
        aria-hidden
      />
    );
  }

  return (
    <Image
      src={image.url}
      // Admin-authored caption when present, else the product title — never empty,
      // so the image always carries an accessible name.
      alt={image.altText ?? productTitle}
      fill
      sizes={sizes}
      // Seed/mock/same-origin sources skip the sharp-requiring optimizer (absent in
      // dev/CI); only remote https (Blob) is optimized. See isUnoptimizedImageSrc.
      unoptimized={isUnoptimizedImageSrc(image.url)}
      preload={preload}
      className="object-cover"
    />
  );
}
