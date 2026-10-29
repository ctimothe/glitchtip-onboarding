import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createExpressErrorMiddleware } from "../src/express/index.js";
import type { Reporter } from "../src/shared/types.js";

function reporterSpy(): Reporter {
  return {
    reportError: vi.fn(() => "event-id"),
    reportWarning: vi.fn(),
    reportInfo: vi.fn(),
    flush: vi.fn(async () => true),
  };
}

describe("createExpressErrorMiddleware", () => {
  it("captures safe route metadata and preserves the next error handler", async () => {
    const reporter = reporterSpy();
    const app = express();
    app.use((req, _res, next) => {
      (req as Request & { id?: string }).id = "req-17";
      next();
    });
    app.get("/orders/:id", () => {
      throw new Error("order failed");
    });
    app.use(createExpressErrorMiddleware(reporter));
    app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      response.status(500).json({ error: "Internal error" });
    });

    const response = await request(app)
      .get("/orders/42?token=should-not-leak")
      .set("authorization", "Bearer should-not-leak");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal error" });
    expect(reporter.reportError).toHaveBeenCalledOnce();
    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "order failed" }),
      {
        requestId: "req-17",
        tags: {
          framework: "express",
          http_method: "GET",
          http_route: "/orders/:id",
          http_status: 500,
        },
      },
    );
    const serialized = JSON.stringify(vi.mocked(reporter.reportError).mock.calls);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("authorization");
  });

  it("uses an error status code without consuming the error", () => {
    const reporter = reporterSpy();
    const middleware = createExpressErrorMiddleware(reporter);
    const error = Object.assign(new Error("unavailable"), { statusCode: 503 });
    const next = vi.fn();
    const req = {
      method: "POST",
      route: { path: "/jobs" },
    } as Request;
    const res = { statusCode: 200 } as Response;

    middleware(error, req, res, next);

    expect(reporter.reportError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: expect.objectContaining({ http_status: 503 }) }),
    );
    expect(next).toHaveBeenCalledWith(error);
  });
});
