import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Instrumentation } from "next";
import { onRequestError } from "@/instrumentation";

/**
 * The `onRequestError` hook is a thin adapter: it maps Next's request/context
 * into `reportError`'s flat context and lifts an error `digest` when present.
 * `reportError` is mocked so these tests assert only that mapping.
 */

const { reportErrorMock } = vi.hoisted(() => ({ reportErrorMock: vi.fn() }));
vi.mock("@/server/observability/error-reporter", () => ({
  reportError: reportErrorMock,
}));

const request: Parameters<Instrumentation.onRequestError>[1] = {
  path: "/checkout",
  method: "POST",
  headers: {},
};
const context: Parameters<Instrumentation.onRequestError>[2] = {
  routerKind: "App Router",
  routePath: "/(storefront)/checkout",
  routeType: "action",
  renderSource: "server-rendering",
  revalidateReason: undefined,
};

beforeEach(() => vi.clearAllMocks());

describe("onRequestError", () => {
  it("forwards the error with request/route context and no digest key when absent", async () => {
    const err = new Error("render blew up");

    await onRequestError(err, request, context);

    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    expect(reportErrorMock).toHaveBeenCalledWith(err, {
      path: "/checkout",
      method: "POST",
      routeType: "action",
      routePath: "/(storefront)/checkout",
    });
  });

  it("lifts a React error digest into the reported context", async () => {
    const err = Object.assign(new Error("boom"), { digest: "abc123" });

    await onRequestError(err, request, context);

    expect(reportErrorMock).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ digest: "abc123" }),
    );
  });
});
