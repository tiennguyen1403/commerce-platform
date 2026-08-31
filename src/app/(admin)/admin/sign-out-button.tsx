"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { authClient } from "@/server/auth/client";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleSignOut() {
    setPending(true);
    try {
      await authClient.signOut();
      router.push("/sign-in");
      router.refresh();
    } catch (error) {
      // Keep the user on the page and let them retry rather than fail silently.
      console.error("Sign out failed", error);
      setPending(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleSignOut}
      disabled={pending}
    >
      <LogOut />
      Sign out
    </Button>
  );
}
