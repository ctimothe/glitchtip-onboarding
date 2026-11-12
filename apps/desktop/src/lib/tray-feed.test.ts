import { describe, expect, it } from "vitest";

import type { InboxIssue } from "./inbox";
import { clipText, trayMenu } from "./tray-feed";
import type { Triage } from "./triage";

const BUG: Triage = { kind: "bug", priority: "important", reasons: [] };
const OUTAGE: Triage = { kind: "outage", priority: "critical", reasons: ["dependency-down"] };
const NOISE: Triage = { kind: "noise", priority: "quiet", reasons: ["scanner"] };

function issue(id: string, patch: Partial<InboxIssue> = {}): InboxIssue {
  return {
    id,
    shortId: `WEB-${id}`,
    title: `Error ${id}`,
    culprit: "",
    level: "error",
    status: "unresolved",
    count: 1,
    userCount: 1,
    firstSeen: "2026-10-29T09:00:00.000Z",
    lastSeen: "2026-10-29T10:00:00.000Z",
    errorType: "Error",
    errorValue: id,
    project: { id: "1", slug: "web", name: "Acme web", platform: "" },
    sourceId: "primary",
    key: `primary:${id}`,
    triage: BUG,
    signals: null,
    ...patch,
  };
}

describe("menu bar item", () => {
  it("lists the errors that need attention, outages first, then by when they were last seen", () => {
    const menu = trayMenu(
      [
        issue("1", { lastSeen: "2026-10-29T08:00:00.000Z" }),
        issue("2", { lastSeen: "2026-10-29T10:00:00.000Z" }),
        issue("3", { lastSeen: "2026-10-29T07:00:00.000Z", triage: OUTAGE }),
        issue("4", { lastSeen: "2026-10-29T11:00:00.000Z", triage: NOISE }),
      ],
      0,
      "en",
    );
    expect(menu.alerts).toEqual([
      { key: "primary:3", text: "Error 3 · Acme web", critical: true },
      { key: "primary:2", text: "Error 2 · Acme web", critical: false },
      { key: "primary:1", text: "Error 1 · Acme web", critical: false },
    ]);
  });

  it("shows the unread count beside the icon and in the tooltip", () => {
    const menu = trayMenu([issue("1")], 3, "en");
    expect(menu.title).toBe("3");
    expect(menu.tooltip).toBe("GlitchTip Companion · 3 new");
  });

  it("clears the count when nothing is unread and says so when nothing needs attention", () => {
    const menu = trayMenu([issue("1", { triage: NOISE })], 0, "en");
    expect(menu.title).toBeNull();
    expect(menu.tooltip).toBe("GlitchTip Companion");
    expect(menu.alerts).toEqual([]);
    expect(menu.labels).toEqual({ empty: "Nothing needs attention", open: "Open GlitchTip Companion", quit: "Quit GlitchTip Companion" });
  });

  it("keeps five rows and clips long titles without rewording them", () => {
    const many = Array.from({ length: 8 }, (_, n) => issue(String(n), { title: "x".repeat(80) }));
    const menu = trayMenu(many, 0, "ru");
    expect(menu.alerts).toHaveLength(5);
    expect(menu.alerts[0].text.startsWith("x".repeat(55) + "…")).toBe(true);
    expect(clipText("short", 10)).toBe("short");
  });
});
