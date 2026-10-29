import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nodeSdk = vi.hoisted(() => {
  type MockScope = Record<
    "setLevel" | "setTags" | "setExtras" | "setUser" | "setFingerprint",
    ReturnType<typeof vi.fn>
  >;
  const scope: MockScope = {
    setLevel: vi.fn(),
    setTags: vi.fn(),
    setExtras: vi.fn(),
    setUser: vi.fn(),
    setFingerprint: vi.fn(),
  };
  return {
    scope,
    init: vi.fn(),
    withScope: vi.fn((callback: (value: MockScope) => unknown) => callback(scope)),
    captureException: vi.fn(() => "node-error-id"),
    captureMessage: vi.fn(() => "node-message-id"),
    flush: vi.fn(async () => true),
    inboundFiltersIntegration: vi.fn(() => ({ name: "InboundFilters" })),
    functionToStringIntegration: vi.fn(() => ({ name: "FunctionToString" })),
    linkedErrorsIntegration: vi.fn(() => ({ name: "LinkedErrors" })),
    dedupeIntegration: vi.fn(() => ({ name: "Dedupe" })),
  };
});

vi.mock("@sentry/node", () => nodeSdk);

import {
  createNodeReporter,
  installProcessErrorHandlers,
  nodeConfigFromEnv,
} from "../src/node/index.js";
import type { Reporter } from "../src/shared/types.js";

describe("createNodeReporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The singleton-warning test below asserts on console.warn, and earlier
    // tests in this describe trigger the one latched warning once the feature
    // exists — swallow it so suite output stays pristine.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("initializes an errors-only Sentry client with private defaults", () => {
    createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "billing-api",
      environment: "production",
      release: "abc123",
      debug: true,
    });

    expect(nodeSdk.init).toHaveBeenCalledOnce();
    expect(nodeSdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://public@example.test/1",
        environment: "production",
        release: "abc123",
        debug: true,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        defaultIntegrations: false,
        integrations: [
          { name: "InboundFilters" },
          { name: "FunctionToString" },
          { name: "LinkedErrors" },
          { name: "Dedupe" },
        ],
        beforeSend: expect.any(Function),
      }),
    );
  });

  it("maps reporter payloads to an isolated Sentry scope", () => {
    const reporter = createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "billing-api",
      environment: "production",
    });

    expect(
      reporter.reportError(new Error("broken"), {
        tags: { job: "invoice" },
        extra: { attempt: 2 },
        user: { id: "opaque-1", role: "operator" },
        fingerprint: ["invoice"],
      }),
    ).toBe("node-error-id");
    expect(nodeSdk.scope.setLevel).toHaveBeenCalledWith("error");
    expect(nodeSdk.scope.setTags).toHaveBeenCalledWith(
      expect.objectContaining({ project: "billing-api", job: "invoice" }),
    );
    expect(nodeSdk.scope.setExtras).toHaveBeenCalledWith({ attempt: 2 });
    expect(nodeSdk.scope.setUser).toHaveBeenCalledWith({ id: "opaque-1", role: "operator" });
    expect(nodeSdk.scope.setFingerprint).toHaveBeenCalledWith(["invoice"]);
    expect(nodeSdk.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "broken" }));
  });

  it("does not initialize or report when the project is blank", async () => {
    const reporter = createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "",
      environment: "production",
    });
    expect(nodeSdk.init).not.toHaveBeenCalled();
    expect(reporter.reportError(new Error("ignored"))).toBeUndefined();
    await expect(reporter.flush()).resolves.toBe(false);
  });

  it("does not initialize or report when the environment is blank", () => {
    const reporter = createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "billing-api",
      environment: "   ",
    });
    expect(nodeSdk.init).not.toHaveBeenCalled();
    expect(reporter.reportError(new Error("ignored"))).toBeUndefined();
  });

  it("honors an explicit enabled: true despite a blank project", () => {
    const forced = createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "",
      environment: "production",
      enabled: true,
    });
    expect(nodeSdk.init).toHaveBeenCalledOnce();
    expect(forced.reportError(new Error("captured"))).toBe("node-error-id");
  });

  it("does not initialize without a DSN and survives initialization failure", () => {
    const disabled = createNodeReporter({ project: "app", environment: "test" });
    expect(nodeSdk.init).not.toHaveBeenCalled();
    expect(disabled.reportError(new Error("ignored"))).toBeUndefined();

    nodeSdk.init.mockImplementationOnce(() => {
      throw new Error("bad DSN");
    });
    const failed = createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    expect(() => failed.reportError(new Error("ignored"))).not.toThrow();
    expect(failed.reportError(new Error("ignored"))).toBeUndefined();
  });

  it("scrubs the complete event before invoking the consumer hook", () => {
    const consumer = vi.fn((event: unknown) => event);
    createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
      beforeSend: consumer,
    });
    const options = nodeSdk.init.mock.calls[0]?.[0] as {
      beforeSend(event: unknown): unknown;
    };
    const result = options.beforeSend({
      request: { headers: { authorization: "Bearer secret" } },
      extra: { email: "person@example.com" },
    });
    expect(result).toEqual({
      request: {},
      extra: { email: "[REDACTED]" },
    });
    expect(consumer).toHaveBeenCalledWith(result);
  });

  it("preserves deep stack frames while scrubbing custom context", () => {
    createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    const options = nodeSdk.init.mock.calls[0]?.[0] as {
      beforeSend(event: unknown): unknown;
    };
    const result = options.beforeSend({
      exception: {
        values: [{
          stacktrace: {
            frames: [{
              filename: "src/orders.ts",
              lineno: 42,
            }],
          },
        }],
      },
      extra: { password: "should-not-leak" },
    });

    expect(result).toEqual({
      exception: {
        values: [{
          stacktrace: {
            frames: [{
              filename: "src/orders.ts",
              lineno: 42,
            }],
          },
        }],
      },
      extra: { password: "[REDACTED]" },
    });
  });

  it("removes local variables from exception frames", () => {
    createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    const options = nodeSdk.init.mock.calls[0]?.[0] as {
      beforeSend(event: unknown): unknown;
    };
    const result = options.beforeSend({
      exception: {
        values: [{ stacktrace: { frames: [{ filename: "worker.ts", vars: { document: "private" } }] } }],
      },
    });

    expect(result).toEqual({
      exception: {
        values: [{ stacktrace: { frames: [{ filename: "worker.ts" }] } }],
      },
    });
  });

  it("preserves event identity, trace ids, absolute paths, and the user id on a realistic event", () => {
    createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    const options = nodeSdk.init.mock.calls[0]?.[0] as {
      beforeSend(event: unknown): unknown;
    };
    const result = options.beforeSend({
      event_id: "b16aa1c4a5c14a6da1a1a1a1a1a1a1a1",
      contexts: { trace: { trace_id: "b16aa1c4a5c14a6da1a1a1a1a1a1a1a1", span_id: "aaaaaaaaaaaaaaaa" } },
      user: { id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" },
      exception: {
        values: [{
          value: "boom",
          stacktrace: {
            frames: [{ filename: "/srv/app/dist/services/payment-processor.js", abs_path: "/srv/app/dist/services/payment-processor.js" }],
          },
        }],
      },
      extra: { token: "abcdefghijklmnopqrstuvwxyz012345" },
    }) as Record<string, any>;

    expect(result.event_id).toBe("b16aa1c4a5c14a6da1a1a1a1a1a1a1a1");
    expect(result.contexts.trace.trace_id).toBe("b16aa1c4a5c14a6da1a1a1a1a1a1a1a1");
    expect(result.user).toEqual({ id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" });
    expect(result.exception.values[0].stacktrace.frames[0].filename).toBe(
      "/srv/app/dist/services/payment-processor.js",
    );
    expect(result.extra).toEqual({ token: "[REDACTED]" });
  });

  it("strips query strings from breadcrumb urls before they leave the process", () => {
    createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    const options = nodeSdk.init.mock.calls[0]?.[0] as {
      beforeSend(event: unknown): unknown;
    };
    const result = options.beforeSend({
      breadcrumbs: [
        { category: "fetch", data: { url: "https://api.example.test/orders?token=abc123", method: "GET" } },
      ],
    }) as Record<string, any>;

    expect(result.breadcrumbs[0].data.url).toBe("https://api.example.test/orders");
  });

  it("warns exactly once when a second reporter initializes in the same runtime", async () => {
    // The latch is module state, so run against a fresh module instance. The
    // vi.mock factory returns the same hoisted nodeSdk singleton, so the
    // existing handle still observes the fresh module's Sentry.init calls.
    vi.resetModules();
    const fresh = await import("../src/node/index.js");
    const initsBefore = nodeSdk.init.mock.calls.length;

    fresh.createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    expect(nodeSdk.init.mock.calls.length).toBe(initsBefore + 1);
    expect(console.warn).not.toHaveBeenCalled();

    fresh.createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    fresh.createNodeReporter({
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain("singleton");
  });
});

describe("nodeConfigFromEnv", () => {
  it("uses explicit values ahead of environment values", () => {
    expect(
      nodeConfigFromEnv(
        {
          GLITCHTIP_DSN: "env-dsn",
          GLITCHTIP_PROJECT: "env-project",
          APP_ENV: "staging",
          APP_RELEASE: "env-release",
        },
        { project: "explicit-project", environment: "production", release: "explicit-release" },
      ),
    ).toEqual({
      dsn: "env-dsn",
      project: "explicit-project",
      environment: "production",
      release: "explicit-release",
    });
  });

  it("can read project and environment entirely from server variables", () => {
    expect(
      nodeConfigFromEnv({
        GLITCHTIP_DSN: "env-dsn",
        GLITCHTIP_PROJECT: "env-project",
        APP_ENV: "staging",
        APP_RELEASE: "env-release",
      }),
    ).toEqual({
      dsn: "env-dsn",
      project: "env-project",
      environment: "staging",
      release: "env-release",
    });
  });

  it("disables reporting when project or environment is missing rather than shipping blank tags", () => {
    expect(nodeConfigFromEnv({ GLITCHTIP_DSN: "env-dsn" }).enabled).toBe(false);
    expect(
      nodeConfigFromEnv({ GLITCHTIP_DSN: "env-dsn", GLITCHTIP_PROJECT: "app" }).enabled,
    ).toBe(false);
  });

  it("respects an explicit enabled override even with a blank project or environment", () => {
    expect(
      nodeConfigFromEnv({ GLITCHTIP_DSN: "env-dsn" }, { enabled: true }).enabled,
    ).toBe(true);
  });
});

describe("installProcessErrorHandlers", () => {
  const initialExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = initialExitCode;
  });

  it("reports rejections, flushes, invokes onFatal, and uninstalls", async () => {
    const reporter: Reporter = {
      reportError: vi.fn(() => "event-id"),
      reportWarning: vi.fn(),
      reportInfo: vi.fn(),
      flush: vi.fn(async () => true),
    };
    const onFatal = vi.fn(async () => undefined);
    const before = process.listenerCount("unhandledRejection");
    const uninstall = installProcessErrorHandlers(reporter, { flushTimeoutMs: 25, onFatal });
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

    const handler = process.listeners("unhandledRejection").at(-1);
    expect(handler).toBeDefined();
    handler?.(new Error("rejected"), Promise.resolve());
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledOnce());

    expect(reporter.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "rejected" }),
      { tags: { mechanism: "unhandledRejection" } },
    );
    expect(reporter.flush).toHaveBeenCalledWith(25);
    uninstall();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
