/**
 * Typed storage errors, thrown at the storage write boundary and handled by the
 * calling service. Kept in a dependency-free module so both the service and any
 * caller can import them without depending on the storage module itself — mirrors
 * `email.errors.ts` / `fulfillment.errors.ts`.
 */

/**
 * Image storage was invoked (to sign an upload or delete an object) but no storage
 * provider is configured — `BLOB_READ_WRITE_TOKEN` is unset and we're in
 * production, so the selector returns no mock (a dev mock must never write to the
 * deployment's read-only `public/` tree, and there is no real bucket to sign
 * against). The `EmailNotConfiguredError` / `FulfillmentNotConfiguredError`
 * analogue for storage: a *permanent* failure surfaced at the write boundary, so a
 * caller can distinguish it from a transient upload fault. Local dev/CI never hit
 * this — the mock is the default there.
 */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Storage is not configured — set BLOB_READ_WRITE_TOKEN to enable image uploads.",
    );
    this.name = "StorageNotConfiguredError";
  }
}
