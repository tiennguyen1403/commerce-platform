import type { ReactNode } from "react";
import Link from "next/link";
import { Store } from "lucide-react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-2 font-semibold tracking-tight"
      >
        <Store className="text-primary size-5" />
        Commerce Platform
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
