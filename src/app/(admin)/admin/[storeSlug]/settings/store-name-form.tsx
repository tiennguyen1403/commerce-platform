"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { updateNameSchema } from "@/lib/validators/settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { updateStoreNameAction } from "./actions";

/**
 * Views and changes the store's display name (`Tenant.name`). A rename is a
 * plain, reversible attribute change — no conversion, no history to preserve —
 * so unlike the currency card there's no confirmation step: just an input and a
 * Save that arms only on a real, non-empty change. The server
 * (`updateStoreNameAction`) stays the authoritative validation + OWNER boundary.
 */
export function StoreNameForm({
  storeSlug,
  currentName,
}: {
  storeSlug: string;
  currentName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Compare on the trimmed value — the server trims too, so trailing spaces
  // aren't a "change" worth enabling Save for, and an all-spaces name is blocked.
  const trimmed = value.trim();
  const changed = trimmed.length > 0 && trimmed !== currentName;

  function onSave() {
    const parsed = updateNameSchema.safeParse({ name: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a store name.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await updateStoreNameAction(storeSlug, parsed.data);
      if (result.ok) {
        setSaved(true);
        // Re-read the page so the header/switcher and this card's baseline pick
        // up the new name (which disarms Save until the next edit).
        router.refresh();
        return;
      }
      setError(
        result.formError ??
          result.fieldErrors?.name ??
          "Couldn’t save the name.",
      );
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Store name</CardTitle>
        <CardDescription>
          The name shown in your storefront header and footer, and across admin.
          Your store’s web address doesn’t change.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <Field className="sm:max-w-sm sm:flex-1">
            <FieldLabel htmlFor="store-name">Name</FieldLabel>
            <Input
              id="store-name"
              value={value}
              maxLength={160}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
                setSaved(false);
              }}
            />
          </Field>
          <Button
            className="w-full sm:w-auto"
            onClick={onSave}
            disabled={!changed || pending}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save name
          </Button>
        </div>

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {saved && !error ? (
          <p role="status" className="text-muted-foreground text-sm">
            Store name saved.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
