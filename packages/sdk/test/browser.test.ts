// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const browserSdk = vi.hoisted(() => {
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
    init: vi.fn(),
    withScope: vi.fn((callback: (value: MockScope) => unknown) => callback(scope)),
    captureException: vi.fn(() => "browser-error-id"),
    captureMessage: vi.fn(() => "browser-message-id"),
    flush: vi.fn(async () => true),
    inboundFiltersIntegration: vi.fn(() => ({ name: "InboundFilters" })),
    functionToStringIntegration: vi.fn(() => ({ name: "FunctionToString" })),
    linkedErrorsIntegration: vi.fn(() => ({ name: "LinkedErrors" })),
    dedupeIntegration: vi.fn(() => ({ name: "Dedupe" })),
    globalHandlersIntegration: vi.fn(() => ({ name: "GlobalHandlers" })),
    breadcrumbsIntegration: vi.fn((opts: unknown) => ({ name: "Breadcrumbs", opts })),
    addBreadcrumb: vi.fn(),
  };
});

vi.mock("@sentry/browser", () => browserSdk);

import {
  browserConfigFromEnv,
  createBrowserReporter,
  installClickBreadcrumbs,
  isBenignBrowserEvent,
} from "../src/browser/index.js";

describe("createBrowserReporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The singleton-warning test below asserts on console.warn, and earlier
    // tests in this describe trigger the one latched warning once the feature
    // exists — swallow it so suite output stays pristine.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("initializes global error capture without tracing or replay", () => {
    createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "shop-web",
      environment: "production",
      release: "abc123",
    });
    expect(browserSdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://public@example.test/1",
        environment: "production",
        release: "abc123",
        sendDefaultPii: false,
        tracesSampleRate: 0,
        defaultIntegrations: false,
        maxBreadcrumbs: 50,
        integrations: [
          { name: "InboundFilters" },
          { name: "FunctionToString" },
          { name: "Breadcrumbs", opts: { console: false, dom: false, fetch: true, history: true, xhr: true } },
          { name: "LinkedErrors" },
          { name: "Dedupe" },
          { name: "GlobalHandlers" },
        ],
        beforeSend: expect.any(Function),
      }),
    );
  });

  it("does not initialize or report when the project is blank", () => {
    const reporter = createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "",
      environment: "production",
    });
    expect(browserSdk.init).not.toHaveBeenCalled();
    expect(reporter.reportError(new Error("ignored"))).toBeUndefined();
  });

  it("does not initialize or report when the environment is blank", () => {
    const reporter = createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "shop-web",
      environment: "",
    });
    expect(browserSdk.init).not.toHaveBeenCalled();
    expect(reporter.reportError(new Error("ignored"))).toBeUndefined();
  });

  it("honors an explicit enabled: true despite a blank project", () => {
    const forced = createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "",
      environment: "production",
      enabled: true,
    });
    expect(browserSdk.init).toHaveBeenCalledOnce();
    expect(forced.reportError(new Error("captured"))).toBe("browser-error-id");
  });

  it("drops benign browser events before the consumer hook", () => {
    const consumer = vi.fn((event: unknown) => event);
    createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "shop-web",
      environment: "production",
      beforeSend: consumer,
    });
    const options = browserSdk.init.mock.calls[0]?.[0] as {
      beforeSend(event: unknown): unknown;
    };
    expect(options.beforeSend({ message: "ResizeObserver loop limit exceeded" })).toBeNull();
    expect(consumer).not.toHaveBeenCalled();
  });

  it("warns exactly once when a second reporter initializes in the same runtime", async () => {
    // The latch is module state, so run against a fresh module instance. The
    // vi.mock factory returns the same hoisted browserSdk singleton, so the
    // existing handle still observes the fresh module's Sentry.init calls.
    vi.resetModules();
    const fresh = await import("../src/browser/index.js");
    const initsBefore = browserSdk.init.mock.calls.length;

    fresh.createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "shop-web",
      environment: "production",
    });
    expect(browserSdk.init.mock.calls.length).toBe(initsBefore + 1);
    expect(console.warn).not.toHaveBeenCalled();

    fresh.createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "shop-web",
      environment: "production",
    });
    fresh.createBrowserReporter({
      dsn: "https://public@example.test/1",
      project: "shop-web",
      environment: "production",
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain("singleton");
  });
});

describe("isBenignBrowserEvent", () => {
  it.each([
    { message: "ResizeObserver loop completed with undelivered notifications." },
    { message: "Script error." },
    { exception: { values: [{ type: "AbortError", value: "The operation was aborted" }] } },
    { request: { url: "chrome-extension://abc/content.js" } },
    { request: { url: "moz-extension://abc/content.js" } },
  ])("recognizes known browser noise", (event) => {
    expect(isBenignBrowserEvent(event)).toBe(true);
  });

  it("keeps actionable application errors", () => {
    expect(isBenignBrowserEvent({ message: "Checkout failed" })).toBe(false);
  });
});

describe("installClickBreadcrumbs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("records the accessible label of a clicked control", () => {
    const uninstall = installClickBreadcrumbs();
    document.body.innerHTML = '<button aria-label="Search now">🔍</button>';
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(browserSdk.addBreadcrumb).toHaveBeenCalledWith({
      category: "ui.click",
      message: "Search now",
      level: "info",
      data: { element: "button" },
    });
    uninstall();
  });

  it("never throws and ignores clicks on non-clickable elements", () => {
    const uninstall = installClickBreadcrumbs();
    expect(() => {
      document.body.innerHTML = "<div>plain text</div>";
      document.querySelector("div")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
    expect(browserSdk.addBreadcrumb).not.toHaveBeenCalled();
    uninstall();
  });

  it("stops recording once uninstalled", () => {
    const uninstall = installClickBreadcrumbs();
    uninstall();
    document.body.innerHTML = '<button aria-label="Search now">🔍</button>';
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(browserSdk.addBreadcrumb).not.toHaveBeenCalled();
  });
});

describe("browserConfigFromEnv", () => {
  it("prefers a Next public DSN and explicit application identity", () => {
    expect(
      browserConfigFromEnv(
        {
          NEXT_PUBLIC_GLITCHTIP_DSN: "next-dsn",
          VITE_GLITCHTIP_DSN: "vite-dsn",
        },
        { project: "shop-web", environment: "production", release: "abc123" },
      ),
    ).toEqual({
      dsn: "next-dsn",
      project: "shop-web",
      environment: "production",
      release: "abc123",
    });
  });
});
