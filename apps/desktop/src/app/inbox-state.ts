// The inbox's live state for the whole window: runs the poller (src/lib/inbox.ts) over every
// connected GlitchTip server while the app runs, polls again on focus and when the network
// returns, sends notifications for the alerts the user asked for, counts what arrived since the
// window last had focus, and carries out what the user chose in a notification or the menu bar.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

import type { Locale } from "../i18n";
import { issueEvidence, listIssues, setIssueStatus } from "../lib/glitchtip";
import {
  createKeyedLock,
  createPoller,
  groupAlerts,
  issueKey,
  sameConnection,
  type SeenMap,
  type SignalsMap,
  type SourceState,
} from "../lib/inbox";
import { alertsToNotify, notifyAlerts } from "../lib/notify";
import * as secrets from "../lib/secrets";
import { readSignals } from "../lib/triage";
import type { NotifyLevel } from "./preferences";
import { inboxSources, type InboxSource, type WorkspaceState } from "./workspace";

const store = new LazyStore("inbox.json");
// Shared by every poller the window starts, so a replaced poller and its successor take turns.
const historyLock = createKeyedLock();

function seenKey(source: InboxSource): string {
  return `seen.${source.id}.${source.verifiedAt}`;
}

function signalsKey(source: InboxSource): string {
  return `signals.${source.id}.${source.verifiedAt}`;
}

/**
 * The issue the inbox should show. `by` tells an alert that arrived from a choice the user made;
 * `error` is why a change the user asked for outside the window (a notification's Resolve or
 * Ignore) did not happen, for the inbox to show beside the issue.
 */
export type InboxFocus = { key: string; by: "alert" | "user"; error?: string };

/**
 * What the user chose in a notification or the menu bar. The Rust side keeps these until the
 * window takes them (`inbox_commands_take`), so one chosen while the app was still starting is
 * not lost. A notification's key carries its connection (`notificationKey` in src/lib/notify.ts);
 * a menu bar row's is the plain inbox key.
 */
export type InboxCommand = { command: "open" | "resolved" | "ignored"; key: string };

/**
 * An inbox key back into its server and issue, with the connection a notification bound it to
 * (null for a plain key). Server ids hold no colon and GlitchTip's issue ids no `@`.
 */
export function parseIssueKey(key: string): { sourceId: string; issueId: string; connection: string | null } | null {
  const bound = key.lastIndexOf("@");
  const plain = bound > 0 ? key.slice(0, bound) : key;
  const at = plain.indexOf(":");
  if (at <= 0 || at >= plain.length - 1 || !/^[a-z0-9][a-z0-9-]*$/.test(plain.slice(0, at))) return null;
  return { sourceId: plain.slice(0, at), issueId: plain.slice(at + 1), connection: bound > 0 ? key.slice(bound + 1) : null };
}

export type InboxState = {
  sources: Record<string, SourceState>;
  /** Errors notified since the window last had focus. */
  unread: number;
  /** The latest notification's issue, or the one the user picked in a notification or the menu bar. */
  focus: InboxFocus | null;
  refresh: () => Promise<void>;
};

function inNativeWindow(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined && window.__COMPANION_PREVIEW__ !== true;
}

export function useInbox(workspace: WorkspaceState | null, locale: Locale, notify: NotifyLevel = "important"): InboxState {
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const [unread, setUnread] = useState(0);
  const [focus, setFocus] = useState<InboxFocus | null>(null);
  const latest = useRef({ workspace, locale, notify });
  useEffect(() => {
    latest.current = { workspace, locale, notify };
  }, [workspace, locale, notify]);
  const pollNow = useRef<() => Promise<void>>(async () => {});

  // Another workspace or a different set of servers restarts the poller; anything else is read
  // through `latest`. GlitchTip proved is enough: the inbox keeps watching while Telegram is being set up.
  const ready = workspace !== null && workspace.glitchtip.verifiedAt !== "";
  const key = ready ? JSON.stringify({ workspaceId: workspace.id, sources: inboxSources(workspace) }) : null;

  useEffect(() => {
    if (key === null) {
      setSources({});
      return;
    }
    const started = JSON.parse(key) as { workspaceId: string; sources: InboxSource[] };
    // A removed server's issues leave at once; a poll still in flight from before cannot bring them back.
    const ids = new Set(started.sources.map((source) => source.id));
    setSources((all) => Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
    let stopped = false;
    const poller = createPoller({
      sources: () => {
        const ws = latest.current.workspace;
        return ws === null ? [] : inboxSources(ws);
      },
      token: async (source) => {
        const ws = latest.current.workspace;
        return ws === null ? null : secrets.get(ws.id, source.tokenKey);
      },
      list: (baseUrl, token, org, cursor) => listIssues(baseUrl, token, org, { cursor }),
      evidence: async (source, token, issue) =>
        readSignals(await issueEvidence(source.baseUrl, token, issue), issue.project.platform),
      loadSeen: async (source) => (await store.get<SeenMap>(seenKey(source))) ?? null,
      saveSeen: async (source, seen) => {
        await store.set(seenKey(source), seen);
        await store.save();
      },
      loadSignals: async (source) => (await store.get<SignalsMap>(signalsKey(source))) ?? null,
      saveSignals: async (source, signals) => {
        await store.set(signalsKey(source), signals);
        await store.save();
      },
      withHistory: (source, task) => historyLock(seenKey(source), task),
      onUpdate: (id, state) => {
        if (!stopped) setSources((all) => ({ ...all, [id]: state }));
      },
      onAlerts: (id, alerts) => {
        // A poller stopped after saving what it found still reports it while that same connection
        // is there: its successor waits for that save (historyLock), compares with it and stays quiet.
        // A server removed, or added again for another organization, reports nothing late.
        const ws = latest.current.workspace;
        if (ws === null || ws.id !== started.workspaceId) return;
        if (!sameConnection(started.sources.find((s) => s.id === id), inboxSources(ws).find((s) => s.id === id))) return;
        const wanted = alertsToNotify(alerts, latest.current.notify);
        if (wanted.length === 0) return;
        const groups = groupAlerts(id, wanted);
        setUnread((n) => n + wanted.length);
        setFocus({ key: issueKey(id, groups[0].issue.id), by: "alert" });
        const connection = started.sources.find((s) => s.id === id)?.verifiedAt ?? "";
        void notifyAlerts(groups, latest.current.locale, connection).catch(() => {
          // The inbox and the menu bar still show the error.
        });
      },
    });
    pollNow.current = poller.pollNow;
    // In the app the minute's beat comes from the Rust side (src-tauri/src/heartbeat.rs): macOS
    // slows a background window's own timers, and the inbox matters most when nobody looks at it.
    const native = inNativeWindow();
    if (native) void poller.pollNow();
    else poller.start();
    const beat = native ? listen("inbox-tick", () => void poller.pollNow()) : null;
    const onFocus = () => {
      setUnread(0);
      void poller.pollNow();
    };
    const onOnline = () => void poller.pollNow();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    return () => {
      stopped = true;
      poller.stop();
      void beat?.then((stop) => stop());
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [key]);

  // A click on a notification or a menu bar row opens that error; a notification's Resolve or
  // Ignore button changes it in GlitchTip without opening the window. A change that fails brings
  // the window forward on that error with the reason, the one place the failure shows.
  // Commands wait on the Rust side until a workspace is here to carry them out.
  useEffect(() => {
    if (!ready || !inNativeWindow()) return;
    async function run({ command, key }: InboxCommand) {
      const ws = latest.current.workspace;
      const parsed = parseIssueKey(key);
      const source = ws && parsed ? inboxSources(ws).find((s) => s.id === parsed.sourceId) : undefined;
      // A notification from a connection that is gone acts on nothing: the server it named was
      // replaced, and the same issue number there is another error.
      if (!ws || !parsed || !source) return;
      if (parsed.connection !== null && parsed.connection !== source.verifiedAt) return;
      const issue = issueKey(parsed.sourceId, parsed.issueId);
      if (command === "open") {
        setFocus({ key: issue, by: "user" });
        return;
      }
      try {
        const token = await secrets.get(ws.id, source.tokenKey);
        if (!token) throw new Error("token-missing");
        await setIssueStatus(source.baseUrl, token, source.organizationSlug, parsed.issueId, command);
        await pollNow.current();
      } catch (err) {
        setFocus({ key: issue, by: "user", error: err instanceof Error ? err.message : String(err) });
        void invoke("window_show").catch(() => undefined);
      }
    }
    let taking = Promise.resolve();
    const take = () => {
      taking = taking
        .then(() => invoke<InboxCommand[]>("inbox_commands_take"))
        .then(async (commands) => {
          for (const command of commands) await run(command);
        })
        .catch(() => undefined);
    };
    const unlisten = listen("inbox-command", take);
    take();
    return () => void unlisten.then((stop) => stop());
  }, [ready]);

  const refresh = useCallback(() => pollNow.current(), []);
  return { sources, unread, focus, refresh };
}
