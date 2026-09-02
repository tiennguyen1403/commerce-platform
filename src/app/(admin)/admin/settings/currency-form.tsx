"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, TriangleAlert } from "lucide-react";
import {
  CURRENCIES,
  CURRENCY_LABELS,
  type CurrencyValue,
} from "@/lib/validators/catalog";
import { updateCurrencySchema } from "@/lib/validators/settings";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { updateStoreCurrencyAction } from "./actions";

/** Friendly label for a currency code, falling back to the upper-cased code for
 *  anything we don't have a label for (e.g. a legacy stored value). */
function currencyLabel(code: string) {
  return CURRENCY_LABELS[code as CurrencyValue] ?? code.toUpperCase();
}

// An illustrative price (integer cents) for the no-conversion warning: the same
// `1999` shown in two currencies makes the "same number, new label" point.
const EXAMPLE_CENTS = 1999;

/**
 * Views and changes the store's single currency (`Tenant.currency`). Because
 * the change only re-labels existing prices — it never converts `priceCents` —
 * it sits behind a confirmation dialog that spells out the effect with a
 * concrete example, and a standing caution explains it up front. The server
 * (`updateStoreCurrencyAction`) stays the real validation + OWNER boundary.
 */
export function CurrencyForm({ currentCurrency }: { currentCurrency: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Seed with the stored code even if it isn't in the supported set, so the
  // Select shows the truth; `changed` still gates whether Save does anything.
  const [selected, setSelected] = useState(currentCurrency);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const changed = selected !== currentCurrency;

  function onConfirm() {
    const parsed = updateCurrencySchema.safeParse({ currency: selected });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Choose a supported currency.",
      );
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await updateStoreCurrencyAction(parsed.data);
      if (result.ok) {
        setOpen(false);
        setDone(
          `Store currency is now ${currencyLabel(parsed.data.currency)}.`,
        );
        router.refresh();
        return;
      }
      setError(
        result.formError ??
          result.fieldErrors?.currency ??
          "Couldn’t change the currency.",
      );
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store currency</CardTitle>
        <CardDescription>
          The single currency every product price and order total uses. Variants
          inherit it — the catalog has no per-variant currency.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="border-destructive/30 bg-destructive/10 flex gap-3 rounded-lg border p-3 text-sm">
          <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="text-foreground font-medium">
              Changing the currency doesn’t convert existing prices.
            </p>
            <p className="text-muted-foreground">
              Prices keep their number and are only re-labelled — a{" "}
              {formatMoney(EXAMPLE_CENTS, currentCurrency)} price stays{" "}
              <span className="text-foreground">{EXAMPLE_CENTS}</span> cents and
              simply shows in the new currency. Past orders keep their original
              currency. Review your prices after changing.
            </p>
          </div>
        </div>

        {done ? (
          <p role="status" className="text-muted-foreground text-sm">
            {done}
          </p>
        ) : null}

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <Field className="sm:w-48">
            <FieldLabel htmlFor="store-currency">Currency</FieldLabel>
            <Select
              value={selected}
              onValueChange={(next) => {
                if (next) {
                  setSelected(next);
                  setDone(null);
                }
              }}
            >
              <SelectTrigger id="store-currency" className="w-full">
                <SelectValue>{(v) => currencyLabel(v as string)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CURRENCY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Dialog
            open={open}
            onOpenChange={(next) => {
              // Don't let Esc / backdrop / close dismiss the dialog mid-save —
              // the error and success feedback live here, so a dismissal during
              // the pending window would drop it silently. Clearing the error on
              // close also avoids flashing a stale one when it's reopened.
              if (pending) return;
              setOpen(next);
              if (!next) setError(null);
            }}
          >
            <DialogTrigger
              render={
                <Button
                  className="w-full sm:w-auto"
                  disabled={!changed || pending}
                />
              }
            >
              Save changes
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change store currency?</DialogTitle>
                <DialogDescription>
                  You’re switching from {currencyLabel(currentCurrency)} to{" "}
                  {currencyLabel(selected)}. Existing prices aren’t converted —{" "}
                  {formatMoney(EXAMPLE_CENTS, currentCurrency)} becomes{" "}
                  {formatMoney(EXAMPLE_CENTS, selected)}, the same number in the
                  new currency. Past orders are unaffected.
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
                <Button onClick={onConfirm} disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" /> : null}
                  Change currency
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );
}
