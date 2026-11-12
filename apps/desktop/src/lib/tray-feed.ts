// The menu bar item's contents: the open errors that need attention, most serious first. Kept free
// of Tauri imports so it runs under plain vitest; TrayManager.tsx pushes the result into the
// Rust-owned tray icon through `tray_update`, and a click on a row comes back as an
// `inbox-command` (src/app/inbox-state.ts).

import { t, type Locale } from "../i18n";
import type { InboxIssue } from "./inbox";
import { needsAttention, PRIORITY_RANK } from "./triage";

export type TrayMenu = {
  tooltip: string;
  /** The unread count beside the icon; null clears it. */
  title: string | null;
  /** `key` is the inbox key a click opens; `critical` picks the red status dot over the amber one. */
  alerts: Array<{ key: string; text: string; critical: boolean }>;
  labels: { empty: string; open: string; quit: string };
};

const MENU_ALERTS = 5;

// Cut with an ellipsis, never reworded.
export function clipText(value: string, n: number): string {
  return value.length > n ? value.slice(0, n - 1) + "…" : value;
}

/** Outages before bugs, the most recently seen first among equals. */
export function byAttention(a: InboxIssue, b: InboxIssue): number {
  return PRIORITY_RANK[b.triage.priority] - PRIORITY_RANK[a.triage.priority] || b.lastSeen.localeCompare(a.lastSeen);
}

/** `unread` counts the errors notified since the window last had focus. */
export function trayMenu(issues: InboxIssue[], unread: number, locale: Locale): TrayMenu {
  const appName = t(locale, "appName");
  const latest = issues.filter((issue) => needsAttention(issue.triage)).sort(byAttention).slice(0, MENU_ALERTS);
  return {
    tooltip: unread === 0 ? appName : `${appName} · ${t(locale, "tray.unread", { count: unread })}`,
    title: unread > 0 ? String(unread) : null,
    alerts: latest.map((issue) => ({
      key: issue.key,
      text: `${clipText(issue.title, 56)} · ${issue.project.name || issue.project.slug}`,
      critical: issue.triage.priority === "critical",
    })),
    labels: { empty: t(locale, "tray.empty"), open: t(locale, "tray.open"), quit: t(locale, "tray.quit") },
  };
}
