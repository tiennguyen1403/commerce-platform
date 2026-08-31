"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { clearCartAction } from "@/app/(storefront)/cart/actions";

/**
 * Empties the guest cart once a payment has succeeded. This runs on the success
 * page (not the webhook) because clearing the cart means writing the shopper's
 * cookie, which a webhook can't reach — only a Server Action in the browser's
 * request can. Guarded on `redirect_status === "succeeded"` so merely opening
 * the URL never wipes a cart, and on a ref so React's double-mount doesn't run
 * it twice. Renders nothing.
 */
export function CheckoutComplete({
  redirectStatus,
}: {
  redirectStatus?: string;
}) {
  const router = useRouter();
  const cleared = useRef(false);

  useEffect(() => {
    if (redirectStatus !== "succeeded" || cleared.current) return;
    cleared.current = true;
    void clearCartAction().then(() => router.refresh());
  }, [redirectStatus, router]);

  return null;
}
