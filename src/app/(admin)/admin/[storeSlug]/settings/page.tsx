import type { Metadata } from "next";
import { requireRole } from "@/server/auth/admin-context";
import { ROLES } from "@/config/roles";
import { StoreNameForm } from "./store-name-form";
import { ThemeForm } from "./theme-form";
import { CurrencyForm } from "./currency-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ storeSlug: string }>;
}) {
  const { storeSlug } = await params;
  // OWNER-only: a member below OWNER is redirected to this store's dashboard.
  // This is the security boundary — the hidden nav link is just UX. Name,
  // accent, and currency all come from the same cached context the storefront
  // and admin read.
  const { tenantName, themeHue, currency } = await requireRole(
    storeSlug,
    ROLES.OWNER,
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm">
          Store-wide settings. Changes apply to the storefront and admin.
        </p>
      </div>

      <StoreNameForm storeSlug={storeSlug} currentName={tenantName} />
      <ThemeForm storeSlug={storeSlug} currentHue={themeHue} />
      <CurrencyForm storeSlug={storeSlug} currentCurrency={currency} />
    </div>
  );
}
