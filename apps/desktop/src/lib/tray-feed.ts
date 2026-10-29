// The menu bar item's contents, built from the relay's delivery records (src/lib/deliveries.ts).
// Kept free of Tauri imports so it runs under plain vitest; TrayManager.tsx reads the records from
// the server and pushes the result into the Rust-owned tray icon through `tray_update`.

import type { WorkspaceState } from "../app/workspace";
import { t, type Locale } from "../i18n";
import { deliveryTitle, type Delivery, type DeliveryState } from "./deliveries";
import { formatDateTime } from "./format";

export type TrayMenu = {
  tooltip: string;
  /** The unread count beside the icon; null clears it. */
  title: string | null;
  alerts: Array<{ id: string; text: string }>;
  labels: { empty: string; open: string; quit: string };
};

const MENU_ALERTS = 5;

// Native menus cannot colour a row, so each state is a circle in the nearest hue.
export const STATE_GLYPH: Record<DeliveryState, string> = {
  error: "🔴",
  warning: "🟡",
  info: "🔵",
  resolved: "🟢",
  setup_complete: "⚪",
  test: "⚪",
};

// Cut with an ellipsis, never reworded.
export function clipText(value: string, n: number): string {
  return value.length > n ? value.slice(0, n - 1) + "…" : value;
}

/**
 * The latest messages the relay delivered to Telegram, newest first, with those delivered after
 * `seenAt` (when the window last had focus) counted as unread.
 */
export function trayMenu(deliveries: Delivery[], workspace: WorkspaceState | null, locale: Locale, seenAt: number): TrayMenu {
  const delivered = workspace === null ? [] : deliveries.filter((delivery) => delivery.status === "delivered");
  const unread = delivered.filter((delivery) => Date.parse(delivery.at) > seenAt).length;
  const appName = t(locale, "appName");
  return {
    tooltip: unread === 0 ? appName : `${appName} · ${t(locale, "tray.unread", { count: unread })}`,
    title: unread > 0 ? String(unread) : null,
    alerts:
      workspace === null
        ? []
        : delivered.slice(0, MENU_ALERTS).map((delivery, index) => ({
            id: `tray-alert-${index}`,
            text: [
              delivery.state === null ? null : STATE_GLYPH[delivery.state],
              clipText(deliveryTitle(delivery, workspace), 48),
              "·",
              formatDateTime(delivery.at, locale),
            ]
              .filter((part) => part !== null)
              .join(" "),
          })),
    labels: { empty: t(locale, "tray.empty"), open: t(locale, "tray.open"), quit: t(locale, "tray.quit") },
  };
}
