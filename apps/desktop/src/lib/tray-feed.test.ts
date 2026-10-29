import { describe, expect, it } from "vitest";

import type { WorkspaceState } from "../app/workspace";
import type { Delivery } from "./deliveries";
import { clipText, trayMenu } from "./tray-feed";

const workspace = {
  locale: "en",
  applications: [{ id: "web", name: "Acme web" }],
} as unknown as WorkspaceState;

function delivery(patch: Partial<Delivery> = {}): Delivery {
  return {
    at: "2026-10-29T10:00:00.000Z",
    applicationId: "web",
    state: "error",
    status: "delivered",
    attempt: 1,
    failure: null,
    nextRetryAt: null,
    ...patch,
  };
}

const BEFORE = Date.parse("2026-10-29T09:00:00.000Z");
const AFTER = Date.parse("2026-10-29T11:00:00.000Z");

describe("menu bar item", () => {
  it("lists delivered alerts newest first by application and state", () => {
    const menu = trayMenu(
      [delivery({ state: "warning", at: "2026-10-29T10:05:00.000Z" }), delivery()],
      workspace,
      "en",
      AFTER,
    );
    expect(menu.alerts.map((alert) => alert.text.split(" · ")[0])).toEqual(["🟡 Acme web", "🔴 Acme web"]);
    expect(menu.alerts[0].text).toContain("Warning");
  });

  it("leaves out sends still being retried and agent prompts", () => {
    const menu = trayMenu([delivery({ status: "retrying", failure: "temporary" }), delivery({ status: "prompt-sent" })], workspace, "en", BEFORE);
    expect(menu.alerts).toEqual([]);
    expect(menu.title).toBeNull();
  });

  it("counts alerts delivered since the window last had focus", () => {
    expect(trayMenu([delivery(), delivery()], workspace, "en", BEFORE)).toMatchObject({
      title: "2",
      tooltip: "GlitchTip Companion · 2 new",
    });
    expect(trayMenu([delivery()], workspace, "en", AFTER)).toMatchObject({ title: null, tooltip: "GlitchTip Companion" });
  });

  it("shows at most five alerts", () => {
    expect(trayMenu(Array.from({ length: 8 }, () => delivery()), workspace, "en", AFTER).alerts).toHaveLength(5);
  });

  it("labels the menu in the workspace's language", () => {
    expect(trayMenu([], null, "ru", AFTER).labels).toEqual({
      empty: "Оповещений пока нет",
      open: "Открыть GlitchTip Companion",
      quit: "Завершить GlitchTip Companion",
    });
  });
});

describe("clipText", () => {
  it("keeps short text and cuts long text with an ellipsis", () => {
    expect(clipText("abcde", 5)).toBe("abcde");
    expect(clipText("abcdef", 5)).toBe("abcd…");
  });
});
