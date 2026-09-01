"use client";

import { type ReactNode, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Ban,
  Loader2,
  PackageCheck,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
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
import type {
  OrderActionResult,
  OrderStatusValue,
} from "@/lib/validators/orders";
import {
  cancelOrderAction,
  fulfillOrderAction,
  refundOrderAction,
} from "./actions";

/**
 * The role- and status-gated lifecycle actions on the order detail page. What
 * shows follows the order service's state machine and role split: Cancel while
 * PENDING and Fulfil while PAID (both STAFF+), Refund while PAID/FULFILLED
 * (ADMIN+ only — `canRefund`). Terminal orders (CANCELLED / REFUNDED), or a
 * state with nothing this member may do, show a muted note instead.
 *
 * Hiding a button is UX, not the security boundary — every action re-checks the
 * role server-side (`assertRole`). Each runs behind a confirmation dialog and,
 * on success, refreshes the server-rendered page so the new status and the newly
 * available actions appear.
 */
export function OrderActions({
  orderId,
  status,
  oversold,
  canRefund,
}: {
  orderId: string;
  status: OrderStatusValue;
  oversold: boolean;
  canRefund: boolean;
}) {
  const canRefundNow =
    canRefund && (status === "PAID" || status === "FULFILLED");
  const hasAction = status === "PENDING" || status === "PAID" || canRefundNow;

  if (!hasAction) {
    return (
      <p className="text-muted-foreground text-sm">
        No actions available for this order.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {status === "PENDING" ? (
        <ConfirmAction
          triggerLabel="Cancel order"
          triggerIcon={<Ban />}
          triggerVariant="outline"
          title="Cancel this order?"
          description="This cancels the pending order and releases its reserved stock. It's only possible while the order is still unpaid."
          dismissLabel="Keep order"
          confirmLabel="Cancel order"
          confirmVariant="destructive"
          action={() => cancelOrderAction(orderId)}
        />
      ) : null}

      {status === "PAID" ? (
        <ConfirmAction
          triggerLabel="Mark fulfilled"
          triggerIcon={<PackageCheck />}
          triggerVariant="default"
          title="Mark this order fulfilled?"
          description="Records that you've shipped or handed off this order. This is a manual status change — no carrier or provider is contacted."
          warning={
            oversold ? (
              <div className="border-destructive/30 bg-destructive/10 flex gap-3 rounded-lg border p-3 text-sm">
                <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
                <div className="flex flex-col gap-1">
                  <p className="text-foreground font-medium">
                    This order was oversold.
                  </p>
                  <p className="text-muted-foreground">
                    One or more items couldn&rsquo;t be fully allocated from
                    stock when payment was captured. Make sure you can actually
                    fulfil it — you may want to refund instead.
                  </p>
                </div>
              </div>
            ) : null
          }
          confirmLabel="Mark fulfilled"
          confirmVariant="default"
          action={() => fulfillOrderAction(orderId)}
        />
      ) : null}

      {canRefundNow ? (
        <ConfirmAction
          triggerLabel="Refund"
          triggerIcon={<RotateCcw />}
          triggerVariant="outline"
          title="Refund this order?"
          description="Starts a full refund through Stripe. Once Stripe confirms the money was returned, the order moves to Refunded. Refunds can't be undone."
          confirmLabel="Refund order"
          confirmVariant="destructive"
          action={() => refundOrderAction(orderId)}
        />
      ) : null}
    </div>
  );
}

/**
 * One lifecycle action behind a confirmation dialog. Shared by cancel / fulfil /
 * refund so they behave identically: disable while pending, surface a refused
 * transition's message inline, and on success close + refresh the page. The
 * dialog can't be dismissed mid-flight (its error/feedback lives here).
 */
function ConfirmAction({
  triggerLabel,
  triggerIcon,
  triggerVariant,
  title,
  description,
  warning,
  dismissLabel = "Cancel",
  confirmLabel,
  confirmVariant,
  action,
}: {
  triggerLabel: string;
  triggerIcon: ReactNode;
  triggerVariant: "default" | "outline";
  title: string;
  description: string;
  warning?: ReactNode;
  dismissLabel?: string;
  confirmLabel: string;
  confirmVariant: "default" | "destructive";
  action: () => Promise<OrderActionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setError(result.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let Esc / backdrop dismiss mid-flight — the error feedback lives
        // in the dialog. Clear a stale error when it closes.
        if (pending) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger render={<Button variant={triggerVariant} size="sm" />}>
        {triggerIcon}
        {triggerLabel}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {warning}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {dismissLabel}
          </DialogClose>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
