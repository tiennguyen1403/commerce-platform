"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { removeMemberAction } from "./actions";

/**
 * Removes a member behind a confirmation dialog. Removal only revokes admin
 * access (the user account itself is untouched), so it's a confirmed action
 * rather than a hard delete. `disabled` covers cases the UI forbids up front —
 * your own row, or the tenant's last owner — with the reason as a tooltip.
 */
export function RemoveMemberButton({
  userId,
  memberName,
  disabled = false,
  disabledReason,
}: {
  userId: string;
  memberName: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (disabled) {
    return (
      <Button variant="ghost" size="sm" disabled title={disabledReason}>
        <UserMinus />
        Remove
      </Button>
    );
  }

  function onRemove() {
    setError(null);
    startTransition(async () => {
      const result = await removeMemberAction(userId);
      if (result.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setError(result.formError ?? "Couldn't remove this member.");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <UserMinus />
        Remove
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {memberName}?</DialogTitle>
          <DialogDescription>
            They lose access to this store’s admin. Their account isn’t deleted,
            and you can add them back anytime.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" onClick={onRemove} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
