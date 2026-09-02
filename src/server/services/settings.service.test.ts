import { describe, it, expect, beforeEach, vi } from "vitest";
import { tenantRepository } from "@/server/repositories/tenant.repository";
import { settingsService } from "@/server/services/settings.service";

/**
 * Unit tests for the settings service, with the tenant repository mocked. Each
 * method is a thin, deliberate delegate (see the service doc), so the contract
 * worth pinning is the same for all three: forward the tenant + the
 * already-validated value to the matching repository method unchanged, and
 * return whatever the repository returns.
 */

vi.mock("@/server/repositories/tenant.repository", () => ({
  tenantRepository: {
    updateCurrency: vi.fn(),
    updateName: vi.fn(),
    updateThemeHue: vi.fn(),
  },
}));

const updateCurrency = vi.mocked(tenantRepository.updateCurrency);
const updateName = vi.mocked(tenantRepository.updateName);
const updateThemeHue = vi.mocked(tenantRepository.updateThemeHue);

const TENANT = "tenant_1";

type TenantRow = Awaited<ReturnType<typeof tenantRepository.updateCurrency>>;

function tenantRow(overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id: TENANT,
    slug: "demo",
    name: "Demo",
    currency: "usd",
    themeHue: 162,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  // Reset (not just clear) so a test that forgets to arm the mock can't inherit
  // a previous test's return value.
  vi.resetAllMocks();
});

describe("settingsService.updateStoreCurrency", () => {
  it("delegates to the repository with the tenant + currency and returns its result", async () => {
    const updated = tenantRow({ currency: "eur" });
    updateCurrency.mockResolvedValue(updated);

    await expect(
      settingsService.updateStoreCurrency(TENANT, "eur"),
    ).resolves.toBe(updated);
    expect(updateCurrency).toHaveBeenCalledWith(TENANT, "eur");
  });
});

describe("settingsService.updateStoreName", () => {
  it("delegates to the repository with the tenant + name and returns its result", async () => {
    const updated = tenantRow({ name: "Aurora Living" });
    updateName.mockResolvedValue(updated);

    await expect(
      settingsService.updateStoreName(TENANT, "Aurora Living"),
    ).resolves.toBe(updated);
    expect(updateName).toHaveBeenCalledWith(TENANT, "Aurora Living");
  });
});

describe("settingsService.updateStoreTheme", () => {
  it("delegates to the repository with the tenant + hue and returns its result", async () => {
    const updated = tenantRow({ themeHue: 290 });
    updateThemeHue.mockResolvedValue(updated);

    await expect(settingsService.updateStoreTheme(TENANT, 290)).resolves.toBe(
      updated,
    );
    expect(updateThemeHue).toHaveBeenCalledWith(TENANT, 290);
  });
});
