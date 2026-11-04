// The menu bar item: the open errors the inbox last read and the count notified since the window
// last had focus, pushed into the Rust-owned tray icon through `tray_update`
// (src/lib/tray-feed.ts builds it). Renders nothing.

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { Locale } from "../i18n";
import type { InboxState } from "../app/inbox-state";
import { trayMenu } from "../lib/tray-feed";

export default function TrayManager({ inbox, locale }: { inbox: InboxState; locale: Locale }) {
  const issues = Object.values(inbox.sources).flatMap((source) => source.issues);
  const menu = JSON.stringify(trayMenu(issues, inbox.unread, locale));

  useEffect(() => {
    invoke("tray_update", JSON.parse(menu)).catch(() => {
      // The menu bar item is a convenience; the inbox stays the full record.
    });
  }, [menu]);

  return null;
}
