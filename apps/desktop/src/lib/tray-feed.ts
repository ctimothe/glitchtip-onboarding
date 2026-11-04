// The menu bar item's contents: the open errors the inbox last read, most recently seen first.
// Kept free of Tauri imports so it runs under plain vitest; TrayManager.tsx pushes the result into
// the Rust-owned tray icon through `tray_update`.

import { t, type Locale } from "../i18n";
import type { Issue } from "./glitchtip";
import { formatDateTime } from "./format";

export type TrayMenu = {
  tooltip: string;
  /** The unread count beside the icon; null clears it. */
  title: string | null;
  alerts: Array<{ id: string; text: string }>;
  labels: { empty: string; open: string; quit: string };
};

const MENU_ALERTS = 5;

// Native menus cannot colour a row, so each level is a circle in the nearest hue.
const LEVEL_GLYPH: Record<string, string> = {
  fatal: "🔴",
  error: "🔴",
  warning: "🟡",
  info: "🔵",
  debug: "⚪",
};

// Cut with an ellipsis, never reworded.
export function clipText(value: string, n: number): string {
  return value.length > n ? value.slice(0, n - 1) + "…" : value;
}

/** `unread` counts the errors notified since the window last had focus. */
export function trayMenu(issues: Issue[], unread: number, locale: Locale): TrayMenu {
  const appName = t(locale, "appName");
  const latest = [...issues].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, MENU_ALERTS);
  return {
    tooltip: unread === 0 ? appName : `${appName} · ${t(locale, "tray.unread", { count: unread })}`,
    title: unread > 0 ? String(unread) : null,
    alerts: latest.map((issue, index) => ({
      id: `tray-alert-${index}`,
      text: [
        LEVEL_GLYPH[issue.level] ?? "⚪",
        clipText(issue.title, 48),
        "·",
        issue.project.name || issue.project.slug,
        "·",
        formatDateTime(issue.lastSeen, locale),
      ].join(" "),
    })),
    labels: { empty: t(locale, "tray.empty"), open: t(locale, "tray.open"), quit: t(locale, "tray.quit") },
  };
}
