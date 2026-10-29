import { describe, expect, it } from "vitest";

import { formatDateTime, formatRelative, hostOf } from "./format";

const NOW = Date.parse("2026-10-28T12:00:00Z");

describe("formatRelative", () => {
  it("reads like the system clock in each language", () => {
    expect(formatRelative("2026-10-28T11:55:00Z", "en", NOW)).toBe("5 minutes ago");
    expect(formatRelative("2026-10-27T12:00:00Z", "en", NOW)).toBe("yesterday");
    expect(formatRelative("2026-10-28T11:59:40Z", "en", NOW)).toBe("now");
    expect(formatRelative("2026-10-28T09:00:00Z", "ru", NOW)).toBe("3 часа назад");
  });

  it("shows a malformed timestamp as it is", () => {
    expect(formatRelative("not a date", "en", NOW)).toBe("not a date");
    expect(formatDateTime("not a date", "en")).toBe("not a date");
  });
});

describe("hostOf", () => {
  it("keeps the host and port only", () => {
    expect(hostOf("https://glitchtip.example.com:8443/path?q=1")).toBe("glitchtip.example.com:8443");
    expect(hostOf("relay.example.com")).toBe("relay.example.com");
  });
});
