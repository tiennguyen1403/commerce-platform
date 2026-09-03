"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2 } from "lucide-react";
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
import { archiveProductAction } from "./actions";

/**
 * Archives a product behind a confirmation dialog. Archiving is reversible
 * (the editor can set the status back), so it's a soft, confirmed action
 * rather than a destructive delete.
 */
export function ArchiveProductButton({
  storeSlug,
  productId,
  productTitle,
}: {
  storeSlug: string;
  productId: string;
  productTitle: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onArchive() {
    setError(null);
    startTransition(async () => {
      const result = await archiveProductAction(storeSlug, productId);
      if (result.ok) {
        setOpen(false);
        router.push(`/admin/${storeSlug}/products`);
        router.refresh();
        return;
      }
      setError(result.formError ?? "Couldn't archive this product.");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        <Archive />
        Archive
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive “{productTitle}”?</DialogTitle>
          <DialogDescription>
            Archived products are hidden from the storefront. You can set the
            status back to Draft or Active anytime from the editor.
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
          <Button variant="destructive" onClick={onArchive} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
