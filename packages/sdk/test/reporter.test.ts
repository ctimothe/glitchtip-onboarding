import { describe, expect, it } from "vitest";

import { createReporter } from "../src/shared/reporter.js";
import type { CaptureBackend, CapturePayload } from "../src/shared/types.js";

class RecordingBackend implements CaptureBackend {
  readonly events: Array<{
    kind: "exception" | "message";
    value: Error | string;
    payload: CapturePayload;
  }> = [];

  captureException(error: Error, payload: CapturePayload): string {
    this.events.push({ kind: "exception", value: error, payload });
    return "error-event";
  }

  captureMessage(message: string, payload: CapturePayload): string {
    this.events.push({ kind: "message", value: message, payload });
    return `${payload.level}-event`;
  }

  async flush(): Promise<boolean> {
    return true;
  }
}

class ThrowingBackend implements CaptureBackend {
  captureException(): string {
    throw new Error("capture failed");
  }

  captureMessage(): string {
    throw new Error("capture failed");
  }

  async flush(): Promise<boolean> {
    throw new Error("flush failed");
  }
}

describe("createReporter", () => {
  it("maps the three methods to stable event templates", () => {
    const backend = new RecordingBackend();
    const reporter = createReporter(backend, {
      dsn: "https://public@example.test/1",
      project: "billing-api",
      environment: "production",
      release: "abc123",
    });

    expect(reporter.reportError(new TypeError("broken"), { requestId: "req-1" })).toBe(
      "error-event",
    );
    expect(reporter.reportWarning("  Payment retrying  ")).toBe("warning-event");
    expect(reporter.reportInfo("Onboarding completed")).toBe("info-event");

    expect(
      backend.events.map(({ kind, payload }) => ({
        kind,
        level: payload.level,
        tags: payload.tags,
        fingerprint: payload.fingerprint,
      })),
    ).toEqual([
      {
        kind: "exception",
        level: "error",
        tags: {
          event_kind: "error",
          project: "billing-api",
          environment: "production",
          release: "abc123",
          request_id: "req-1",
        },
        fingerprint: undefined,
      },
      {
        kind: "message",
        level: "warning",
        tags: {
          event_kind: "warning",
          project: "billing-api",
          environment: "production",
          release: "abc123",
        },
        fingerprint: ["{{ default }}", "Payment retrying"],
      },
      {
        kind: "message",
        level: "info",
        tags: {
          event_kind: "info",
          project: "billing-api",
          environment: "production",
          release: "abc123",
        },
        fingerprint: ["{{ default }}", "Onboarding completed"],
      },
    ]);
  });

  it("normalizes non-Error throws and scrubs per-event context", () => {
    const backend = new RecordingBackend();
    const reporter = createReporter(backend, {
      dsn: "https://public@example.test/1",
      project: "worker",
      environment: "staging",
    });

    reporter.reportError(
      { code: "BROKEN", token: "secret-value" },
      {
        tags: { queue: "emails", project: "caller-cannot-replace-project" },
        extra: { customer: { email: "person@example.com", retry: 2 } },
        user: { id: "opaque-17", role: "admin" },
        fingerprint: ["worker-broken"],
      },
    );

    const event = backend.events[0];
    expect(event?.value).toBeInstanceOf(Error);
    expect((event?.value as Error).message).toContain("BROKEN");
    expect((event?.value as Error).message).not.toContain("secret-value");
    expect(event?.payload).toEqual({
      level: "error",
      tags: {
        queue: "emails",
        project: "worker",
        event_kind: "error",
        environment: "staging",
      },
      extra: { customer: { email: "[REDACTED]", retry: 2 } },
      user: { id: "opaque-17", role: "admin" },
      fingerprint: ["worker-broken"],
    });
  });

  it("does nothing when reporting is disabled", async () => {
    const backend = new RecordingBackend();
    const reporter = createReporter(backend, {
      project: "app",
      environment: "test",
    });

    expect(reporter.reportError(new Error("boom"))).toBeUndefined();
    expect(reporter.reportWarning("warning")).toBeUndefined();
    expect(reporter.reportInfo("info")).toBeUndefined();
    expect(await reporter.flush()).toBe(false);
    expect(backend.events).toEqual([]);
  });

  it("never throws when the backend fails", async () => {
    const reporter = createReporter(new ThrowingBackend(), {
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });

    expect(() => reporter.reportError("boom")).not.toThrow();
    expect(() => reporter.reportWarning("warning")).not.toThrow();
    expect(() => reporter.reportInfo("info")).not.toThrow();
    expect(await reporter.flush()).toBe(false);
  });

  it("ignores blank warning and info messages", () => {
    const backend = new RecordingBackend();
    const reporter = createReporter(backend, {
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });

    expect(reporter.reportWarning("   ")).toBeUndefined();
    expect(reporter.reportInfo("\n")).toBeUndefined();
    expect(backend.events).toEqual([]);
  });

  it("never throws when a JavaScript caller passes a non-string message", () => {
    const reporter = createReporter(new RecordingBackend(), {
      dsn: "https://public@example.test/1",
      project: "app",
      environment: "test",
    });

    // TypeScript types say `string`, but plain-JS callers are not held to that.
    expect(() => reporter.reportWarning(null as unknown as string)).not.toThrow();
    expect(() => reporter.reportWarning(undefined as unknown as string)).not.toThrow();
    expect(() => reporter.reportWarning(42 as unknown as string)).not.toThrow();
    expect(() => reporter.reportInfo({ toString: () => { throw new Error("boom"); } } as unknown as string)).not.toThrow();
    expect(reporter.reportWarning(42 as unknown as string)).toBeUndefined();
  });
});
