import { describe, it, expect, beforeEach, vi } from "vitest";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { settingsService } from "@/server/services/settings.service";

/**
 * Unit test for the settings service, with the tenant repository mocked. The
 * service is a thin, deliberate delegate — a currency change is a re-label, not
 * a price conversion (see the service doc) — so the contract worth pinning is
 * that it forwards the tenant + already-validated currency to the repository
 * unchanged, and returns whatever the repository returns.
 */

vi.mock("@/server/repositories/tenant.repository", () => ({
  tenantRepository: { updateCurrency: vi.fn() },
}));

const updateCurrency = vi.mocked(tenantRepository.updateCurrency);

const TENANT = "tenant_1";

type TenantRow = Awaited<ReturnType<typeof tenantRepository.updateCurrency>>;

function tenantRow(currency: string): TenantRow {
  return {
    id: TENANT,
    slug: "demo",
    name: "Demo",
    currency,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  // Reset (not just clear) so a test that forgets to arm the mock can't inherit
  // a previous test's return value.
  vi.resetAllMocks();
});

describe("settingsService.updateStoreCurrency", () => {
  it("delegates to the repository with the tenant + currency and returns its result", async () => {
    const updated = tenantRow("eur");
    updateCurrency.mockResolvedValue(updated);

    await expect(
      settingsService.updateStoreCurrency(TENANT, "eur"),
    ).resolves.toBe(updated);
    expect(updateCurrency).toHaveBeenCalledWith(TENANT, "eur");
  });
});
