// Mac notifications for the inbox: one per project and kind of alert (see groupAlerts in ./inbox).
// Permission is asked the first time there is something to show, not at launch.
//
// The app's own Rust side posts them through the system's notification centre (`notify_post` in
// src-tauri/src/notifications.rs), which gives each one Resolve and Ignore buttons, groups them by
// project and tells the window which error was clicked. Where that is not available (a build that
// is not an app bundle), the notification plugin shows the same text without the buttons.

import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

import type { NotifyLevel } from "../app/preferences";
import { t, type Locale } from "../i18n";
import { issueKey, type AlertGroup, type IssueAlert } from "./inbox";
import { needsAttention } from "./triage";

/** The alerts worth a notification at the chosen level. */
export function alertsToNotify(alerts: IssueAlert[], level: NotifyLevel): IssueAlert[] {
  if (level === "off") return [];
  return level === "all" ? alerts : alerts.filter((alert) => needsAttention(alert.triage));
}

export type NotificationText = {
  title: string;
  /** Why the leading error was read the way it was; empty when the kind says it all. */
  subtitle: string;
  body: string;
};

export function notificationText(group: AlertGroup, locale: Locale): NotificationText {
  const values = { project: group.projectName, count: group.count };
  const many = group.count === 1 ? "one" : "many";
  const title =
    group.triage.kind === "outage"
      ? t(locale, "notify.outage", values)
      : t(locale, `notify.${group.kind}.${many}`, values);
  const reason = group.triage.reasons[0];
  return {
    title,
    subtitle: reason ? t(locale, `triage.reason.${reason}`) : "",
    body: group.count === 1 ? group.issue.title : t(locale, "notify.more", { title: group.issue.title, count: group.count - 1 }),
  };
}

/** What the system's notification centre is handed for one group. */
export type NativeNotification = NotificationText & {
  /**
   * The leading issue's inbox key and the connection it was read over (`notificationKey`), handed
   * back when the notification or one of its buttons is clicked.
   */
  key: string;
  /** Notifications of one project stack together. */
  thread: string;
  critical: boolean;
  /** Resolve and Ignore buttons: only where the notification is about one error. */
  actions: boolean;
};

/**
 * An inbox key bound to the connection that produced it. A notification outlives the server it
 * came from: once that server is replaced, its buttons must not reach the new one, whose issue
 * with the same number is another error (`parseIssueKey` in src/app/inbox-state.ts checks).
 */
export function notificationKey(sourceId: string, issueId: string, connection: string): string {
  return `${issueKey(sourceId, issueId)}@${connection}`;
}

/** `connection` is when the group's server was proved (`InboxSource.verifiedAt`). */
export function nativeNotification(group: AlertGroup, locale: Locale, connection: string): NativeNotification {
  return {
    ...notificationText(group, locale),
    key: notificationKey(group.sourceId, group.issue.id, connection),
    thread: `${group.sourceId}:${group.issue.project.id}`,
    critical: group.triage.priority === "critical",
    actions: group.count === 1,
  };
}

// Remembered only once granted, so a permission given later in System Settings is picked up.
let granted = false;

async function allowed(): Promise<boolean> {
  granted ||= (await isPermissionGranted()) || (await requestPermission()) === "granted";
  return granted;
}

export async function notifyAlerts(groups: AlertGroup[], locale: Locale, connection: string): Promise<void> {
  if (groups.length === 0) return;
  const actions = { resolve: t(locale, "inbox.resolve"), ignore: t(locale, "inbox.ignore") };
  try {
    const notifications = groups.map((group) => nativeNotification(group, locale, connection));
    await invoke("notify_post", { notifications, actions });
    return;
  } catch {
    // Not an app bundle, the notification centre refused, or the user has not answered its
    // question yet: fall back to the plugin.
  }
  if (!(await allowed())) return;
  for (const group of groups) {
    const { title, subtitle, body } = notificationText(group, locale);
    sendNotification({ title, body: subtitle ? `${subtitle}\n${body}` : body });
  }
}
