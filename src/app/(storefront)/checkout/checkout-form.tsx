"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type FormEvent,
} from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Check, Loader2, Lock } from "lucide-react";
import {
  checkoutInputSchema,
  SHIPPING_COUNTRIES,
  SHIPPING_COUNTRY_LABELS,
  type ShippingCountry,
} from "@/lib/validators/checkout";
import { cn, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { startCheckoutAction } from "./actions";
import { buildCheckoutAppearance } from "./checkout-appearance";

/**
 * Payment Element checkout. The Element can only mount once a PaymentIntent
 * exists, so this is a two-phase form: collect the email + shipping address first
 * (which validates them, creates the intent, and writes a PENDING order with the
 * address server-side), then swap in `<PaymentElement>` keyed by the returned
 * `clientSecret`. The server owns the amount — the cart is re-priced from live
 * variants there — so nothing money-related is trusted here, and the address is
 * re-validated server-side too (this form's zod check is UX only).
 */

// Publishable key inlined at the client call site: a NEXT_PUBLIC_* literal Next
// can statically inline, never routed through the server-only env.ts. Created
// once at module scope per Stripe's guidance; loadStripe safely no-ops on the
// server, so this is fine to evaluate during SSR of the (dynamic) checkout page.
const stripePromise = loadStripe(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
);

type StartedCheckout = {
  clientSecret: string;
  totalCents: number;
  currency: string;
};

/** The address the form collects, all controlled strings (empty = not filled).
 *  Matches the `shippingAddress` shape of `checkoutInputSchema`; `country` is
 *  seeded to the single supported country so the picker is never empty. */
type AddressState = {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
};

const EMPTY_ADDRESS: AddressState = {
  name: "",
  line1: "",
  line2: "",
  city: "",
  state: "",
  postalCode: "",
  country: SHIPPING_COUNTRIES[0],
};

function countryLabel(code: string): string {
  return SHIPPING_COUNTRY_LABELS[code as ShippingCountry] ?? code;
}

export function CheckoutForm() {
  const [started, setStarted] = useState<StartedCheckout | null>(null);
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState<AddressState>(EMPTY_ADDRESS);
  // Per-field messages, keyed by field name ("email", "name", "line1", …). The
  // authoritative check is the Server Action; this mirror gives immediate,
  // field-level feedback without a round trip.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Match the embedded Stripe card to the OS color scheme so it isn't a
  // light widget stranded on a dark checkout page (the app follows
  // prefers-color-scheme). Subscribed so a live OS theme switch re-themes it.
  const [prefersDark, setPrefersDark] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) =>
      setPrefersDark(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Theme the Payment Element from our design tokens (emerald accent, radius,
  // borders) rather than Stripe's default blue presets. Recomputed when the OS
  // scheme flips so the embedded widget re-themes with the rest of the page;
  // `<Elements>` applies a changed appearance live (no remount needed).
  const appearance = useMemo(
    () => buildCheckoutAppearance(prefersDark),
    [prefersDark],
  );

  const setField = (key: keyof AddressState) => (value: string) =>
    setAddress((prev) => ({ ...prev, [key]: value }));

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = checkoutInputSchema.safeParse({
      email,
      shippingAddress: address,
    });
    if (!parsed.success) {
      // First message wins per field (the path's last segment is the field name),
      // so a field never flickers between its own competing rules.
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[issue.path.length - 1] ?? "form");
        if (!next[key]) next[key] = issue.message;
      }
      setFieldErrors(next);
      return;
    }
    setFieldErrors({});

    setPending(true);
    const result = await startCheckoutAction(parsed.data);
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    setStarted({
      clientSecret: result.clientSecret,
      totalCents: result.totalCents,
      currency: result.currency,
    });
    setPending(false);
  }

  // Phase 2: the PaymentIntent exists — mount the Payment Element for it.
  if (started) {
    return (
      <div className="flex flex-col gap-6">
        <CheckoutSteps current={2} />
        <div className="flex flex-col gap-4">
          {/* A read-back of what was collected in step one, before the card. */}
          <dl className="border-border bg-muted/40 flex flex-col gap-2 rounded-lg border px-4 py-3 text-sm">
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted-foreground shrink-0">Contact</dt>
              <dd className="text-right font-medium">{email}</dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-muted-foreground shrink-0">Ship to</dt>
              <dd className="text-right font-medium">
                {address.name} ·{" "}
                {[address.city, address.state, address.postalCode]
                  .filter(Boolean)
                  .join(", ")}
              </dd>
            </div>
          </dl>
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret: started.clientSecret,
              appearance,
            }}
          >
            <PaymentStep
              totalCents={started.totalCents}
              currency={started.currency}
            />
          </Elements>
        </div>
      </div>
    );
  }

  // Phase 1: collect the email + shipping address; submitting validates them and
  // creates the intent + PENDING order (with the address) server-side.
  return (
    <form onSubmit={onStart} className="flex flex-col gap-6" noValidate>
      <CheckoutSteps current={1} />

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium">Contact</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          {fieldErrors.email ? (
            <p
              id="email-error"
              role="alert"
              className="text-destructive text-sm"
            >
              {fieldErrors.email}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Your receipt and order updates go here.
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium">Shipping address</legend>

        <TextField
          id="ship-name"
          label="Full name"
          autoComplete="name"
          value={address.name}
          onValueChange={setField("name")}
          error={fieldErrors.name}
        />
        <TextField
          id="ship-line1"
          label="Address"
          autoComplete="address-line1"
          placeholder="123 Main St"
          value={address.line1}
          onValueChange={setField("line1")}
          error={fieldErrors.line1}
        />
        <TextField
          id="ship-line2"
          label="Apartment, suite, etc."
          optional
          autoComplete="address-line2"
          value={address.line2}
          onValueChange={setField("line2")}
          error={fieldErrors.line2}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="ship-city"
            label="City"
            autoComplete="address-level2"
            value={address.city}
            onValueChange={setField("city")}
            error={fieldErrors.city}
          />
          <TextField
            id="ship-state"
            label="State"
            autoComplete="address-level1"
            value={address.state}
            onValueChange={setField("state")}
            error={fieldErrors.state}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="ship-postal"
            label="ZIP code"
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="94103"
            value={address.postalCode}
            onValueChange={setField("postalCode")}
            error={fieldErrors.postalCode}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ship-country">Country</Label>
            <Select
              value={address.country}
              onValueChange={(next) => {
                if (next) setField("country")(next);
              }}
            >
              <SelectTrigger
                id="ship-country"
                className="w-full"
                aria-invalid={fieldErrors.country ? true : undefined}
                aria-describedby={
                  fieldErrors.country ? "ship-country-error" : undefined
                }
              >
                <SelectValue>
                  {(value) => countryLabel(value as string)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SHIPPING_COUNTRIES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {SHIPPING_COUNTRY_LABELS[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldErrors.country ? (
              <p
                id="ship-country-error"
                role="alert"
                className="text-destructive text-sm"
              >
                {fieldErrors.country}
              </p>
            ) : null}
          </div>
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? <Loader2 className="animate-spin" /> : null}
          Continue to payment
        </Button>
        <p className="text-muted-foreground text-center text-xs">
          You won&apos;t be charged until you confirm payment.
        </p>
      </div>
    </form>
  );
}

/** The checkout's two-phase progress: "Details" (collect email + address) then
 *  "Payment" (the mounted Payment Element). The active step takes the accent and
 *  the completed step a check; the numbers and hairline connector are decorative
 *  (`aria-hidden`), while `aria-current="step"` names the live step to assistive
 *  tech. Module scope, so it never remounts between phases. */
function CheckoutSteps({ current }: { current: 1 | 2 }) {
  const steps = [
    { n: 1, label: "Details" },
    { n: 2, label: "Payment" },
  ] as const;

  return (
    <nav aria-label="Checkout progress">
      <ol className="flex items-center gap-3">
        {steps.map((step) => {
          const done = current > step.n;
          const active = current === step.n;
          return (
            <li
              key={step.n}
              aria-current={active ? "step" : undefined}
              className={cn("flex items-center gap-2", step.n > 1 && "flex-1")}
            >
              {step.n > 1 ? (
                <span aria-hidden className="bg-border h-px flex-1" />
              ) : null}
              <span
                aria-hidden
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
                  done || active
                    ? "bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground border",
                )}
              >
                {done ? <Check className="size-4" /> : step.n}
              </span>
              <span
                className={cn(
                  "text-sm font-medium whitespace-nowrap",
                  active || done ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.label}
                {done ? <span className="sr-only"> completed</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** A labelled text input with inline error text — the address form's field
 *  primitive. Defined at module scope (not inside `CheckoutForm`) so it keeps a
 *  stable identity across renders and never remounts mid-typing. */
function TextField({
  id,
  label,
  value,
  onValueChange,
  error,
  optional,
  ...inputProps
}: {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  optional?: boolean;
} & Omit<
  ComponentProps<typeof Input>,
  "id" | "value" | "onChange" | "required" | "aria-invalid" | "aria-describedby"
>) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <span className="text-muted-foreground font-normal"> (optional)</span>
        ) : null}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        // `optional` is the single source of truth for requiredness: every field
        // but line2 is required, exposed to assistive tech (the form is
        // `noValidate`, so this is a semantics hint, not native validation UI).
        required={!optional}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...inputProps}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The card step, rendered inside `<Elements>` so it can use the Stripe hooks. */
function PaymentStep({
  totalCents,
  currency,
}: {
  totalCents: number;
  currency: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onPay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Stripe.js / Elements not ready yet (the button is disabled, but guard).
    if (!stripe || !elements) return;

    setError(null);
    setPending(true);

    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/checkout/success`,
      },
    });

    // Reached only when confirmation fails *before* the redirect (card declined,
    // validation, network). On success the browser navigates to return_url, so we
    // keep the button in its pending state while that happens.
    if (confirmError) {
      setError(
        confirmError.message ??
          "Payment could not be completed. Please try again.",
      );
      setPending(false);
    }
  }

  return (
    <form onSubmit={onPay} className="flex flex-col gap-5">
      <PaymentElement />
      {process.env.NODE_ENV !== "production" ? (
        <p className="text-muted-foreground text-xs">
          Test mode — use card{" "}
          <span className="font-medium">4242 4242 4242 4242</span>, any future
          expiry, any CVC and postal code.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        size="lg"
        disabled={!stripe || pending}
        className="w-full"
      >
        {pending ? <Loader2 className="animate-spin" /> : <Lock />}
        Pay {formatMoney(totalCents, currency)}
      </Button>
    </form>
  );
}
