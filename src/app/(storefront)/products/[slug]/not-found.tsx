import Link from "next/link";
import { PackageX } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

/** Shown when a PDP slug doesn't resolve to an ACTIVE product. Defined below
 *  the storefront layout so the store shell (header/footer) stays in place. */
export default function ProductNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-4 px-6 py-24 text-center">
      <PackageX className="text-muted-foreground size-10" />
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Product not found
        </h1>
        <p className="text-muted-foreground">
          This product may have sold out or is no longer available.
        </p>
      </div>
      <Link href="/products" className={buttonVariants({ variant: "outline" })}>
        Browse all products
      </Link>
    </div>
  );
}
