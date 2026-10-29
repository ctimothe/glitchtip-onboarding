import "reflect-metadata";

import { Controller, Get, HttpException, type INestApplication, Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGlitchTipExceptionFilter } from "../src/nest/index.js";
import type { Reporter } from "../src/shared/types.js";

function reporterSpy(): Reporter {
  return {
    reportError: vi.fn(() => "event-id"),
    reportWarning: vi.fn(),
    reportInfo: vi.fn(),
    flush: vi.fn(async () => true),
  };
}

@Controller()
class OrdersController {
  @Get("/orders/:id")
  order(): never {
    throw new HttpException({ statusCode: 418, message: "Teapot" }, 418);
  }

  @Get("/unknown")
  unknown(): never {
    throw new Error("unknown failure");
  }
}

describe("createGlitchTipExceptionFilter", () => {
  let app: INestApplication | undefined;
  let loggerError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loggerError = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    loggerError.mockRestore();
  });

  async function createApp(reporter: Reporter): Promise<INestApplication> {
    const module = await Test.createTestingModule({ controllers: [OrdersController] }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(createGlitchTipExceptionFilter(reporter, app.getHttpAdapter()));
    await app.init();
    return app;
  }

  it("captures safe HTTP metadata and preserves Nest's HttpException response", async () => {
    const reporter = reporterSpy();
    const nestApp = await createApp(reporter);

    const response = await request(nestApp.getHttpServer())
      .get("/orders/42?token=should-not-leak")
      .set("authorization", "Bearer should-not-leak");

    expect(response.status).toBe(418);
    expect(response.body).toEqual({ statusCode: 418, message: "Teapot" });
    expect(reporter.reportError).toHaveBeenCalledOnce();
    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.any(HttpException),
      {
        tags: {
          framework: "nest",
          http_method: "GET",
          http_route: "/orders/:id",
          http_status: 418,
        },
      },
    );
    const serialized = JSON.stringify(vi.mocked(reporter.reportError).mock.calls);
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("authorization");
  });

  it("preserves Nest's standard response for unknown errors", async () => {
    const reporter = reporterSpy();
    const nestApp = await createApp(reporter);

    const response = await request(nestApp.getHttpServer()).get("/unknown");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ statusCode: 500, message: "Internal server error" });
    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "unknown failure" }),
      expect.objectContaining({ tags: expect.objectContaining({ http_status: 500 }) }),
    );
  });
});
