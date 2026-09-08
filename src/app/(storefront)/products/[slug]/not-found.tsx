import Link from "next/link";
import { PackageX } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/** Shown when a PDP slug doesn't resolve to an ACTIVE product. Defined below
 *  the storefront layout so the store shell (header/footer) stays in place. */
export default function ProductNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-4 py-16 text-center md:px-6 lg:py-24">
      {/* The house tinted-circle empty state (a neutral circle, never the accent). */}
      <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
        <PackageX className="size-7" aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          Product not found
        </h1>
        <p className="text-muted-foreground text-pretty">
          This product may have sold out or is no longer available.
        </p>
      </div>
      <Link href="/products" className={buttonVariants({ variant: "outline" })}>
        Browse all products
      </Link>
    </div>
  );
}
