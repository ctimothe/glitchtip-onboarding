import { describe, expect, it } from "vitest";

import { scrubValue } from "../src/shared/scrub.js";

describe("scrubValue", () => {
  it("redacts sensitive keys without mutating the input", () => {
    const input = {
      password: "hunter2",
      nested: { email: "person@example.com", safe: "visible" },
      authorization: "Bearer abc.def.ghi",
    };

    expect(scrubValue(input)).toEqual({
      password: "[REDACTED]",
      nested: { email: "[REDACTED]", safe: "visible" },
      authorization: "[REDACTED]",
    });
    expect(input.nested.email).toBe("person@example.com");
  });

  it("redacts credential-like string values", () => {
    expect(
      scrubValue({
        bearer: "Bearer abc.def.ghi",
        assignment: "api_key=sk_live_123456789",
        longValue: "a".repeat(40),
      }),
    ).toEqual({
      bearer: "[REDACTED]",
      assignment: "[REDACTED]",
      longValue: "[REDACTED]",
    });
  });

  it("marks cycles and values below the configured depth", () => {
    const input: Record<string, unknown> = {
      level: { deeper: { value: 1 } },
    };
    input.self = input;

    expect(scrubValue(input, { maxDepth: 2 })).toEqual({
      level: { deeper: "[MAX_DEPTH]" },
      self: "[CIRCULAR]",
    });
  });

  it("normalizes dates, errors, and unsupported primitives", () => {
    expect(
      scrubValue({
        date: new Date("2026-09-06T00:00:00.000Z"),
        error: new TypeError("broken"),
        bigint: 12n,
        missing: undefined,
      }),
    ).toEqual({
      date: "2026-09-06T00:00:00.000Z",
      error: { name: "TypeError", message: "broken" },
      bigint: "12",
      missing: "undefined",
    });
  });
});
