"use client";

import { useEffect, useState, type FormEvent } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Loader2, Lock } from "lucide-react";
import { checkoutInputSchema } from "@/lib/validators/checkout";
import { formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { startCheckoutAction } from "./actions";

/**
 * Payment Element checkout. The Element can only mount once a PaymentIntent
 * exists, so this is a two-phase form: collect the email first (which creates
 * the intent + a PENDING order server-side), then swap in `<PaymentElement>`
 * keyed by the returned `clientSecret`. The server owns the amount — the cart is
 * re-priced from live variants there — so nothing money-related is trusted here.
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

export function CheckoutForm() {
  const [started, setStarted] = useState<StartedCheckout | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [emailInvalid, setEmailInvalid] = useState(false);
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

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setEmailInvalid(false);

    const parsed = checkoutInputSchema.safeParse({ email });
    if (!parsed.success) {
      setEmailInvalid(true);
      setError(
        parsed.error.issues[0]?.message ?? "Enter a valid email address.",
      );
      return;
    }

    setPending(true);
    const result = await startCheckoutAction({ email: parsed.data.email });
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
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          Paying as <span className="text-foreground font-medium">{email}</span>
        </p>
        <Elements
          stripe={stripePromise}
          options={{
            clientSecret: started.clientSecret,
            appearance: { theme: prefersDark ? "night" : "stripe" },
          }}
        >
          <PaymentStep
            totalCents={started.totalCents}
            currency={started.currency}
          />
        </Elements>
      </div>
    );
  }

  // Phase 1: collect the email; submitting creates the intent + PENDING order.
  return (
    <form onSubmit={onStart} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={emailInvalid || undefined}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <p className="text-muted-foreground text-xs">
          Your receipt and order updates go here.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? <Loader2 className="animate-spin" /> : null}
        Continue to payment
      </Button>
    </form>
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
