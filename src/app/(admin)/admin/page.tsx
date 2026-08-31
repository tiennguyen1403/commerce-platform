import Link from "next/link";
import { ArrowLeft, Package } from "lucide-react";
import { requireAdminContext } from "@/server/auth/admin-context";
import { buttonVariants } from "@/components/ui/button";

export default async function AdminHome() {
  // Reuses the layout's cached context — no second DB round-trip — to show that
  // the resolved tenant/role are available to child admin pages.
  const { userName, role } = await requireAdminContext();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
      <p className="text-muted-foreground max-w-prose">
        Catalog and orders land here through M1. Signed in as{" "}
        <span className="text-foreground font-medium">{userName}</span> ({role}
        ).
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/products" className={buttonVariants()}>
          <Package />
          Manage products
        </Link>
        <Link href="/" className={buttonVariants({ variant: "ghost" })}>
          <ArrowLeft />
          Back to storefront
        </Link>
      </div>
    </div>
  );
}
