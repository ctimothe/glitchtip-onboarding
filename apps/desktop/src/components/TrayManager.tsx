// The menu bar item and the Dock badge: the open errors that need attention and the count notified
// since the window last had focus. The menu is pushed into the Rust-owned tray icon through
// `tray_update` (src/lib/tray-feed.ts builds it). Renders nothing.

import { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { Locale } from "../i18n";
import type { InboxState } from "../app/inbox-state";
import { inboxIssues } from "../lib/inbox";
import { trayMenu } from "../lib/tray-feed";

const NONE: ReadonlySet<string> = new Set();

export default function TrayManager({ inbox, locale }: { inbox: InboxState; locale: Locale }) {
  const issues = useMemo(() => inboxIssues(inbox.sources, NONE), [inbox.sources]);
  const menu = JSON.stringify(trayMenu(issues, inbox.unread, locale));

  useEffect(() => {
    invoke("tray_update", JSON.parse(menu)).catch(() => {
      // The menu bar item is a convenience; the inbox stays the full record.
    });
  }, [menu]);

  useEffect(() => {
    try {
      void getCurrentWindow()
        .setBadgeCount(inbox.unread > 0 ? inbox.unread : undefined)
        .catch(() => undefined);
    } catch {
      // Not inside a Tauri window (tests, browser preview).
    }
  }, [inbox.unread]);

  return null;
}
