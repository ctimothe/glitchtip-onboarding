// The relay's delivery audit (assets/relay/server.js `writeAudit`), read through `relay_audit_tail`.
// A record holds ids, states, times and a failure code only: the alert itself is never stored on
// the server, so its title cannot be shown here.

import type { WorkspaceState } from "../app/workspace";
import { t, type Locale, type TranslationKey } from "../i18n";
import { formatDateTime, formatTime } from "./format";

export type DeliveryStatus = "delivered" | "retrying" | "prompt-sent";
export type DeliveryState = "error" | "warning" | "resolved" | "info" | "setup_complete" | "test";
/** What stopped a send: the bot token, the Telegram group or topic, a passing outage, or the relay. */
export type DeliveryFailure = "bot-token" | "telegram" | "temporary" | "relay";

export type Delivery = {
  at: string;
  applicationId: string;
  state: DeliveryState | null;
  status: DeliveryStatus;
  /** Which send this record is about, counting from 1; null for an agent prompt. */
  attempt: number | null;
  failure: DeliveryFailure | null;
  nextRetryAt: string | null;
};

const STATUSES: readonly string[] = ["delivered", "retrying", "prompt-sent"] satisfies DeliveryStatus[];
const STATES: readonly string[] = ["error", "warning", "resolved", "info", "setup_complete", "test"] satisfies DeliveryState[];

// assets/relay/failure-code.js: a rejected token, a refused chat or topic, and outages the relay
// rides out; every other code is the relay's own.
function failureOf(code: unknown): DeliveryFailure | null {
  if (typeof code !== "string") return null;
  if (code === "telegram-401") return "bot-token";
  if (code === "telegram-400" || code === "telegram-403" || code === "telegram-404") return "telegram";
  if (code === "telegram-429" || code === "telegram-500" || code === "network-error") return "temporary";
  return "relay";
}

/** The relay's audit records, oldest first as it returns them, as deliveries newest first. */
export function readDeliveries(records: ReadonlyArray<Record<string, unknown>>): Delivery[] {
  const deliveries: Delivery[] = [];
  for (const record of records) {
    const { at, applicationId, status, state, retryCount, failureCode, nextRetryAt } = record;
    if (typeof at !== "string" || typeof applicationId !== "string") continue;
    if (typeof status !== "string" || !STATUSES.includes(status)) continue;
    const retries = typeof retryCount === "number" ? retryCount : 0;
    deliveries.push({
      at,
      applicationId,
      state: typeof state === "string" && STATES.includes(state) ? (state as DeliveryState) : null,
      status: status as DeliveryStatus,
      // A delivered record counts the sends that failed before it; a retrying one includes its own.
      attempt: status === "delivered" ? retries + 1 : status === "retrying" ? retries : null,
      failure: status === "retrying" ? failureOf(failureCode) : null,
      nextRetryAt: status === "retrying" && typeof nextRetryAt === "string" ? nextRetryAt : null,
    });
  }
  return deliveries.reverse();
}

/**
 * The relay's word on one queued event, polling its audit through `tail`: delivered; retrying for
 * a reason that will not pass by itself (a refused token or topic); or, at `timeoutMs`, the last
 * retry seen, or null when the audit never named the event. The relay sends within seconds.
 */
export async function waitForDelivery(
  eventId: string,
  tail: () => Promise<ReadonlyArray<Record<string, unknown>>>,
  {
    timeoutMs = 30_000,
    intervalMs = 2_000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Delivery | null> {
  let latest: Delivery | null = null;
  for (let waited = 0; ; waited += intervalMs) {
    const records = (await tail()).filter((record) => record.eventId === eventId);
    latest = readDeliveries(records).find((delivery) => delivery.status !== "prompt-sent") ?? latest;
    if (latest?.status === "delivered") return latest;
    if (latest !== null && latest.failure !== "temporary") return latest;
    if (waited >= timeoutMs) return latest;
    await sleep(intervalMs);
  }
}

const STATE_LABEL: Record<DeliveryState, TranslationKey> = {
  error: "state.error",
  warning: "state.warning",
  resolved: "state.resolved",
  info: "state.info",
  setup_complete: "state.setupComplete",
  test: "state.test",
};

export const STATUS_LABEL: Record<DeliveryStatus, TranslationKey> = {
  delivered: "delivery.delivered",
  retrying: "delivery.retrying",
  "prompt-sent": "delivery.promptSent",
};

export const FAILURE_LABEL: Record<DeliveryFailure, TranslationKey> = {
  "bot-token": "delivery.failure.botToken",
  telegram: "delivery.failure.telegram",
  temporary: "delivery.failure.temporary",
  relay: "delivery.failure.relay",
};

/** "Acme web · Error": the application by its name while the workspace still has it. */
export function deliveryTitle(delivery: Delivery, workspace: WorkspaceState): string {
  const app = workspace.applications.find((candidate) => candidate.id === delivery.applicationId);
  const name = app?.name ?? delivery.applicationId;
  return delivery.state === null ? name : `${name} · ${t(workspace.locale, STATE_LABEL[delivery.state])}`;
}

/** When it happened, which send, and why it failed: "29 Oct, 14:02 · Attempt 2 · Telegram could not be reached". */
export function deliveryDetail(delivery: Delivery, locale: Locale): string {
  const parts = [formatDateTime(delivery.at, locale)];
  if (delivery.attempt !== null && (delivery.attempt > 1 || delivery.status === "retrying")) {
    parts.push(t(locale, "delivery.attempt", { count: delivery.attempt }));
  }
  if (delivery.failure !== null) parts.push(t(locale, FAILURE_LABEL[delivery.failure]));
  if (delivery.nextRetryAt !== null) parts.push(t(locale, "delivery.nextTry", { time: formatTime(delivery.nextRetryAt, locale) }));
  return parts.join(" · ");
}
