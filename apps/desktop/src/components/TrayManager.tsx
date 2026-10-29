// The menu bar item: the latest alerts the relay delivered, read from its audit on the server
// (`relay_audit_tail`) once a minute while the app runs and whenever the window gains focus, then
// pushed into the Rust-owned tray icon through `tray_update` (src/lib/tray-feed.ts builds it).
// Unread counts alerts delivered since the window last had focus. Renders nothing.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { WorkspaceState } from "../app/workspace";
import type { Locale } from "../i18n";
import { readDeliveries, type Delivery } from "../lib/deliveries";
import { relayAuditTail, serverRequestFor } from "../lib/remote";
import { trayMenu } from "../lib/tray-feed";

const POLL_MS = 60_000;
const AUDIT_LINES = 200;

export default function TrayManager({ workspace, locale }: { workspace: WorkspaceState | null; locale: Locale }) {
  // Application names change without restarting the poll; a different server restarts it.
  const latest = useRef(workspace);
  useEffect(() => {
    latest.current = workspace;
  }, [workspace]);
  const server = workspace?.relay ? JSON.stringify(serverRequestFor(workspace.relay)) : null;

  useEffect(() => {
    let stopped = false;
    let busy = false;
    let seenAt = Date.now();
    let deliveries: Delivery[] = [];

    async function push() {
      try {
        await invoke("tray_update", trayMenu(deliveries, latest.current, locale, seenAt));
      } catch {
        // The menu bar item is a convenience; Delivery activity stays the full record.
      }
    }

    async function refresh() {
      if (server !== null && !busy) {
        busy = true;
        try {
          deliveries = readDeliveries(await relayAuditTail({ ...JSON.parse(server), lines: AUDIT_LINES }));
        } catch {
          // Keep the last list; the next poll retries.
        } finally {
          busy = false;
        }
      }
      if (!stopped) await push();
    }

    const onFocus = () => {
      seenAt = Date.now();
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [server, locale]);

  return null;
}
