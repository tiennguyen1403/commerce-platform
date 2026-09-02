import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only: Next 16 blocks cross-origin dev-asset/HMR requests by default, which
  // breaks per-tenant subdomains like `demo.localhost:3000` under `next dev`.
  // Allow any `*.localhost` origin so local subdomain testing works. Ignored by
  // `next build`/`next start`, so production and the Playwright suite are
  // unaffected. See `src/proxy.ts` for how the host maps to a tenant.
  allowedDevOrigins: ["*.localhost"],
};

export default nextConfig;
