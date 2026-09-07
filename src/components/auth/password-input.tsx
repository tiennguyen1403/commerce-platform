"use client";

import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A password field with a show/hide toggle. Presentation-only wrapper around the
 * shared {@link Input}: the eye button flips the input `type` between "password"
 * and "text" and never touches the value, the field's `name`/`id`, or its label
 * association — so `getByLabel("Password")` and the form's submit contract are
 * unchanged. Shared by {@link SignInForm} and {@link SignUpForm}, which drive
 * both the storefront and platform auth surfaces, so it must stay E2E-safe.
 *
 * The toggle is a native `<button type="button">` (never submits the form),
 * keyboard-focusable with a visible ring. `type` is fixed here, so callers pass
 * every other input prop (`id`, `name`, `autoComplete`, `aria-invalid`, …).
 */
export function PasswordInput({
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pr-9", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((prev) => !prev)}
        // Accessible name is "Show"/"Hide" — deliberately WITHOUT the word
        // "password" (the GOV.UK reveal-toggle wording). The auth E2E specs fill
        // the field with a non-exact `getByLabel("Password")`, which matches on a
        // case-insensitive *substring*: an "Show password" name would make that
        // locator resolve to two elements (input + this button) and break admin
        // sign-in, onboarding, and product-images. `title` carries the fuller
        // wording for a sighted mouse-over. (Same substring trap as the
        // safe-redirect prefix-check lesson — re-validate the whole string.)
        aria-label={visible ? "Hide" : "Show"}
        title={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-3"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
