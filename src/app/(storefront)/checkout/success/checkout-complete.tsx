"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { clearCartAction } from "@/app/(storefront)/cart/actions";

/**
 * Empties the guest cart once a payment has succeeded. This runs on the success
 * page (not the webhook) because clearing the cart means writing the shopper's
 * cookie, which a webhook can't reach — only a Server Action in the browser's
 * request can. `succeeded` is computed server-side from the verified PaymentIntent
 * status, so merely opening the URL never wipes a cart; a ref guards React's
 * double-mount so it runs at most once. Renders nothing.
 */
export function CheckoutComplete({ succeeded }: { succeeded: boolean }) {
  const router = useRouter();
  const cleared = useRef(false);

  useEffect(() => {
    if (!succeeded || cleared.current) return;
    cleared.current = true;
    void clearCartAction().then(() => router.refresh());
  }, [succeeded, router]);

  return null;
}
