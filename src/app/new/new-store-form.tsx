"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Store } from "lucide-react";
import {
  createStoreSchema,
  type StoreFieldErrors,
} from "@/lib/validators/tenant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { createStoreAction } from "./actions";

type FormErrors = StoreFieldErrors & { form?: string };

// Shown beside the slug so the owner sees the address they're claiming. Derived
// from the public app URL; falls back to the dev host if it's unset/malformed.
const APP_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
      .host;
  } catch {
    return "localhost:3000";
  }
})();

/**
 * Create a store you own. The client-side zod parse is UX-only; the Server
 * Action re-validates and re-derives the session as the authoritative boundary
 * (it never trusts a client-supplied owner). On success the browser navigates
 * into the new store's admin, where the owner's membership is already in place.
 */
export function NewStoreForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsed = createStoreSchema.safeParse({ name, slug });
    if (!parsed.success) {
      const next: FormErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "name" && !next.name) next.name = issue.message;
        if (key === "slug" && !next.slug) next.slug = issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    startTransition(async () => {
      const result = await createStoreAction(parsed.data);
      if (result.ok) {
        // Land the new owner in their store's admin; refresh drops the stale RSC
        // cache so the membership-scoped chrome reflects the store they just made.
        router.push(`/admin/${result.slug}`);
        router.refresh();
        return;
      }
      const next: FormErrors = {};
      if (result.formError) next.form = result.formError;
      if (result.fieldErrors) Object.assign(next, result.fieldErrors);
      setErrors(next);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store details</CardTitle>
        <CardDescription>
          Name your store and choose its subdomain. You&apos;ll be its owner.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
          noValidate
        >
          {errors.form ? (
            <p
              role="alert"
              className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border px-3 py-2 text-sm"
            >
              {errors.form}
            </p>
          ) : null}

          <Field>
            <FieldLabel htmlFor="store-name">Store name</FieldLabel>
            <Input
              id="store-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={Boolean(errors.name)}
              placeholder="Ada's Emporium"
              autoComplete="off"
            />
            <FieldError
              errors={errors.name ? [{ message: errors.name }] : undefined}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="store-slug">Subdomain</FieldLabel>
            <Input
              id="store-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              aria-invalid={Boolean(errors.slug)}
              aria-describedby="store-slug-desc"
              placeholder="ada-emporium"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldDescription id="store-slug-desc">
              {slug ? `${slug}.${APP_HOST}` : `your-store.${APP_HOST}`}
            </FieldDescription>
            <FieldError
              errors={errors.slug ? [{ message: errors.slug }] : undefined}
            />
          </Field>

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? <Loader2 className="animate-spin" /> : <Store />}
            Create store
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
