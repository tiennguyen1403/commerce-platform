"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { authClient } from "@/server/auth/client";

/**
 * Client-driven shopper sign-out, shared by the desktop {@link AccountMenu} and
 * the mobile nav drawer so both surfaces behave identically (and the auth call
 * lives in one place). Sign-out is `authClient.signOut` — never a server action,
 * so it can't touch another identity; afterwards the shopper goes to the catalog
 * and we `refresh()` so the server re-renders the nav in its guest state.
 *
 * On failure we keep the shopper where they are and re-enable the control to
 * retry rather than failing silently. `signOut` resolves `true` only on success,
 * so a caller can act on it (e.g. the mobile drawer closes itself) without ever
 * closing on the error path.
 */
export function useSignOut() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<boolean> {
    if (signingOut) return false;
    setSigningOut(true);
    try {
      await authClient.signOut();
      router.push("/products");
      router.refresh();
      return true;
    } catch (error) {
      console.error("Sign out failed", error);
      setSigningOut(false);
      return false;
    }
  }

  return { signingOut, signOut };
}
