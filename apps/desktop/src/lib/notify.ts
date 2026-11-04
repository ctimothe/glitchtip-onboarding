// Mac notifications for the inbox: one per project and kind (see groupAlerts in ./inbox).
// Permission is asked the first time there is something to show, not at launch.

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

import { t, type Locale } from "../i18n";
import type { AlertGroup } from "./inbox";

export function notificationText(group: AlertGroup, locale: Locale): { title: string; body: string } {
  const values = { project: group.projectName, count: group.count };
  const title =
    group.kind === "new"
      ? t(locale, group.count === 1 ? "notify.new.one" : "notify.new.many", values)
      : t(locale, group.count === 1 ? "notify.regression.one" : "notify.regression.many", values);
  return { title, body: group.issue.title };
}

// Remembered only once granted, so a permission given later in System Settings is picked up.
let granted = false;

async function allowed(): Promise<boolean> {
  granted ||= (await isPermissionGranted()) || (await requestPermission()) === "granted";
  return granted;
}

export async function notifyAlerts(groups: AlertGroup[], locale: Locale): Promise<void> {
  if (groups.length === 0 || !(await allowed())) return;
  for (const group of groups) sendNotification(notificationText(group, locale));
}
