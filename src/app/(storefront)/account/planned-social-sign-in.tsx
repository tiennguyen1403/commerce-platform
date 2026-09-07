import { Button } from "@/components/ui/button";

/**
 * The social sign-in row on the storefront auth cards — shipped ahead of the
 * feature by an explicit product decision (M6-09 v2; see GOAL.md → Exceptions).
 * Better Auth is email + password only today, so the buttons are disabled and
 * the row says so; nothing here calls an auth provider. Storefront-only — the
 * platform `(auth)` pages don't render it.
 */
export function PlannedSocialSignIn({ dividerText }: { dividerText: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="bg-border h-px flex-1" aria-hidden />
        <span className="text-muted-foreground text-xs">{dividerText}</span>
        <span className="bg-border h-px flex-1" aria-hidden />
      </div>
      {/* `disabled` drops pointer events on the buttons themselves, so the
          hover hint rides on the wrapper. */}
      <div className="grid grid-cols-2 gap-2" title="Coming soon">
        <Button type="button" variant="outline" disabled>
          Google
        </Button>
        <Button type="button" variant="outline" disabled>
          Apple
        </Button>
      </div>
      <p className="text-muted-foreground text-center text-xs">
        Social sign-in is coming soon.
      </p>
    </div>
  );
}
