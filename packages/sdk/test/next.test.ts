import { describe, expect, it, vi } from "vitest";

import {
  captureRequestError,
  reportNextError,
  withRouteErrorCapture,
} from "../src/next/index.js";
import type { Reporter } from "../src/shared/types.js";

function reporterSpy(): Reporter {
  return {
    reportError: vi.fn(() => "event-id"),
    reportWarning: vi.fn(),
    reportInfo: vi.fn(),
    flush: vi.fn(async () => true),
  };
}

describe("Next.js adapter", () => {
  it("captures method and pathname without a query string", () => {
    const reporter = reporterSpy();
    const error = new Error("request failed");

    expect(
      captureRequestError(
        reporter,
        error,
        new Request("https://app.test/orders?token=should-not-leak", { method: "POST" }),
        { requestId: "req-4", tags: { runtime: "nodejs" } },
      ),
    ).toBe("event-id");
    expect(reporter.reportError).toHaveBeenCalledWith(error, {
      requestId: "req-4",
      tags: {
        runtime: "nodejs",
        framework: "next",
        http_method: "POST",
        http_route: "/orders",
      },
    });
    expect(JSON.stringify(vi.mocked(reporter.reportError).mock.calls)).not.toContain(
      "should-not-leak",
    );
  });

  it("reports errors from client error components", () => {
    const reporter = reporterSpy();
    const error = Object.assign(new Error("render failed"), { digest: "next-digest" });

    reportNextError(reporter, error, { tags: { error_surface: "global-error" } });

    expect(reporter.reportError).toHaveBeenCalledWith(error, {
      tags: {
        error_surface: "global-error",
        framework: "next",
      },
    });
  });

  it("wraps route handlers, reports once, and rethrows the same error", async () => {
    const reporter = reporterSpy();
    const error = new Error("route failed");
    const handler = vi.fn(async (_request: Request, _context: { params: Promise<{ id: string }> }) => {
      throw error;
    });
    const wrapped = withRouteErrorCapture(reporter, handler);
    const request = new Request("https://app.test/api/orders/4?secret=value");
    const context = { params: Promise.resolve({ id: "4" }) };

    await expect(wrapped(request, context)).rejects.toBe(error);
    expect(handler).toHaveBeenCalledWith(request, context);
    expect(reporter.reportError).toHaveBeenCalledOnce();
    expect(reporter.reportError).toHaveBeenCalledWith(error, {
      tags: {
        framework: "next",
        http_method: "GET",
        http_route: "/api/orders/4",
      },
    });
  });

  it("uses nextUrl pathname and safe fallbacks for structural requests", () => {
    const reporter = reporterSpy();
    captureRequestError(reporter, "broken", {
      method: "PATCH",
      url: "not a URL",
      nextUrl: { pathname: "/safe-route" },
    });
    expect(reporter.reportError).toHaveBeenCalledWith("broken", {
      tags: {
        framework: "next",
        http_method: "PATCH",
        http_route: "/safe-route",
      },
    });
  });

  it("supports the path field supplied by Next instrumentation hooks", () => {
    const reporter = reporterSpy();
    captureRequestError(reporter, new Error("instrumentation failure"), {
      method: "PUT",
      path: "/instrumented/orders?secret=value",
    });

    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      {
        tags: {
          framework: "next",
          http_method: "PUT",
          http_route: "/instrumented/orders",
        },
      },
    );
  });

  it("resolves a Pages Router relative url instead of falling back to unknown", () => {
    const reporter = reporterSpy();
    captureRequestError(reporter, new Error("pages router failure"), {
      method: "GET",
      url: "/api/orders?token=secret",
    });

    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      {
        tags: {
          framework: "next",
          http_method: "GET",
          http_route: "/api/orders",
        },
      },
    );
  });
});
