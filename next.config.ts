import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: Next 16 blocks cross-origin dev-asset/HMR requests by default, which
  // breaks per-tenant subdomains like `demo.localhost:3000` under `next dev`.
  // Allow any `*.localhost` origin so local subdomain testing works. Ignored by
  // `next build`/`next start`, so production and the Playwright suite are
  // unaffected. See `src/proxy.ts` for how the host maps to a tenant.
  allowedDevOrigins: ["*.localhost"],
  images: {
    // Allow `next/image` to optimize real product images served from Vercel Blob's
    // public object host, `https://<storeId>.public.blob.vercel-storage.com/…`
    // (M5 #189 — the URL shape the `VercelBlobStorageProvider` mints). `*` matches
    // the single store-id subdomain segment; `https` only. Without this, a remote
    // Blob URL is refused by `next/image` outright. The local mock's uploads are
    // root-relative (`/uploads/…`) and same-origin, so they never need an entry
    // here (and render `unoptimized` — `isUnoptimizedImageSrc`, so no `sharp` in CI).
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },
};

export default nextConfig;
