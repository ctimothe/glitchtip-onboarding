import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createFastifyErrorHook } from "../src/fastify/index.js";
import type { Reporter } from "../src/shared/types.js";

function reporterSpy(): Reporter {
  return {
    reportError: vi.fn(() => "event-id"),
    reportWarning: vi.fn(),
    reportInfo: vi.fn(),
    flush: vi.fn(async () => true),
  };
}

describe("createFastifyErrorHook", () => {
  it("captures safe route metadata without replacing Fastify's response", async () => {
    const reporter = reporterSpy();
    const app = Fastify({ logger: false });
    app.addHook("onError", createFastifyErrorHook(reporter));
    app.get("/orders/:id", async () => {
      throw Object.assign(new Error("service unavailable"), { statusCode: 503 });
    });

    const response = await app.inject({
      method: "GET",
      url: "/orders/42?token=should-not-leak",
      headers: { authorization: "Bearer should-not-leak" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      statusCode: 503,
      error: "Service Unavailable",
      message: "service unavailable",
    });
    expect(reporter.reportError).toHaveBeenCalledOnce();
    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "service unavailable" }),
      {
        requestId: expect.any(String),
        tags: {
          framework: "fastify",
          http_method: "GET",
          http_route: "/orders/:id",
          http_status: 503,
        },
      },
    );
    const serialized = JSON.stringify(vi.mocked(reporter.reportError).mock.calls);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("authorization");
    await app.close();
  });

  it("calls the hook callback exactly once", () => {
    const reporter = reporterSpy();
    const done = vi.fn();
    const hook = createFastifyErrorHook(reporter);

    hook.call(
      {} as never,
      {
        id: "req-7",
        method: "POST",
        routerPath: "/jobs",
      } as never,
      { statusCode: 200 } as never,
      new Error("failed") as never,
      done,
    );

    expect(done).toHaveBeenCalledOnce();
    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ http_route: "/jobs", http_status: 500 }),
      }),
    );
  });
});
