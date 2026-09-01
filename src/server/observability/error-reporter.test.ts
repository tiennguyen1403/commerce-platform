import { describe, it, expect, beforeEach, vi } from "vitest";
import { reportError } from "@/server/observability/error-reporter";

/**
 * Unit tests for the error-reporting seam. `@/lib/env` is stubbed with a *mutable*
 * object so each test can toggle `ERROR_WEBHOOK_URL` (the reporter reads it at call
 * time), the logger is mocked to a spy, and `fetch` is stubbed. The contract under
 * test: always log once; POST only when a webhook URL is set; normalize non-Error
 * throws; and never throw, even when the POST itself fails.
 */

// Mutable so a test can flip the webhook on/off between cases.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { ERROR_WEBHOOK_URL: undefined as string | undefined },
}));
vi.mock("@/lib/env", () => ({ env: mockEnv }));

// Spy on the structured logger (mocking the alias also intercepts the relative
// `./logger` import inside the reporter — both resolve to the same file).
const { errorMock } = vi.hoisted(() => ({ errorMock: vi.fn() }));
vi.mock("@/server/observability/logger", () => ({
  logger: { error: errorMock },
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.ERROR_WEBHOOK_URL = undefined;
  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("reportError", () => {
  it("always logs one structured error-level line with the error and context", async () => {
    const err = new Error("kaboom");

    await reportError(err, { action: "startCheckout", tenantId: "t_1" });

    expect(errorMock).toHaveBeenCalledTimes(1);
    const [payload, message] = errorMock.mock.calls[0];
    expect(payload).toMatchObject({
      err,
      action: "startCheckout",
      tenantId: "t_1",
    });
    expect(message).toBe("kaboom");
  });

  it("does not POST when ERROR_WEBHOOK_URL is unset", async () => {
    await reportError(new Error("no webhook"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledTimes(1);
  });

  it("does not POST when ERROR_WEBHOOK_URL is blank", async () => {
    // `optionalEnvString` maps a blank var to undefined, but the reporter's own
    // truthy check must also treat "" as "no webhook".
    mockEnv.ERROR_WEBHOOK_URL = "";

    await reportError(new Error("blank webhook"));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a compact summary to the webhook when the URL is set", async () => {
    mockEnv.ERROR_WEBHOOK_URL = "https://hooks.example.test/abc";

    await reportError(new TypeError("bad thing"), { action: "catalog-write" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.test/abc");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    // Bound by a timeout so a hung endpoint can't stall the failing request.
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body as string);
    // `text` (Slack) and `content` (Discord) carry the same human summary.
    expect(body.text).toBe(body.content);
    expect(body.text).toContain("TypeError");
    expect(body.text).toContain("bad thing");
    expect(body.text).toContain("action=catalog-write");
    expect(body.error).toEqual({ name: "TypeError", message: "bad thing" });
    expect(body.context).toEqual({ action: "catalog-write" });
  });

  it("normalizes a non-Error throw into an Error", async () => {
    mockEnv.ERROR_WEBHOOK_URL = "https://hooks.example.test/abc";

    await reportError("just a string");

    const [payload, message] = errorMock.mock.calls[0];
    expect(payload.err).toBeInstanceOf(Error);
    expect(payload.err.message).toBe("just a string");
    expect(message).toBe("just a string");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.error).toEqual({ name: "Error", message: "just a string" });
  });

  it("never throws and logs the failure when the POST rejects", async () => {
    mockEnv.ERROR_WEBHOOK_URL = "https://hooks.example.test/abc";
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(reportError(new Error("original"))).resolves.toBeUndefined();

    // Two lines: the original report, then the delivery-failure note.
    expect(errorMock).toHaveBeenCalledTimes(2);
    expect(errorMock.mock.calls[1][1]).toContain(
      "failed to POST to ERROR_WEBHOOK_URL",
    );
  });
});
