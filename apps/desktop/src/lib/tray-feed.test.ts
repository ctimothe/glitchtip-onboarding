import { describe, expect, it } from "vitest";

import type { Issue } from "./glitchtip";
import { clipText, trayMenu } from "./tray-feed";

function issue(id: string, patch: Partial<Issue> = {}): Issue {
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
    project: { id: "1", slug: "web", name: "Acme web" },
    ...patch,
  };
}

describe("menu bar item", () => {
  it("lists open errors by when they were last seen, with level, project and time", () => {
    const menu = trayMenu(
      [
        issue("1", { lastSeen: "2026-10-29T08:00:00.000Z", level: "warning" }),
        issue("2", { lastSeen: "2026-10-29T10:00:00.000Z" }),
      ],
      0,
      "en",
    );
    expect(menu.alerts.map((alert) => alert.text)).toEqual([
      expect.stringMatching(/^🔴 Error 2 · Acme web · /),
      expect.stringMatching(/^🟡 Error 1 · Acme web · /),
    ]);
    expect(menu.alerts[0].id).toBe("tray-alert-0");
  });

  it("shows the unread count beside the icon and in the tooltip", () => {
    expect(trayMenu([issue("1")], 0, "en")).toMatchObject({ title: null, tooltip: "GlitchTip Companion" });
    expect(trayMenu([issue("1")], 3, "en")).toMatchObject({ title: "3", tooltip: "GlitchTip Companion · 3 new" });
  });

  it("shows at most five errors", () => {
    expect(trayMenu(["1", "2", "3", "4", "5", "6", "7"].map((id) => issue(id)), 0, "en").alerts).toHaveLength(5);
  });

  it("labels the menu in the workspace's language", () => {
    expect(trayMenu([], 0, "ru").labels).toEqual({
      empty: "Открытых ошибок нет",
      open: "Открыть GlitchTip Companion",
      quit: "Завершить GlitchTip Companion",
    });
  });
});

describe("clipText", () => {
  it("keeps short text and cuts long text with an ellipsis", () => {
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("abcdefghijkl", 5)).toBe("abcd…");
  });
});
