// The inbox's live state for the whole window: runs the poller (src/lib/inbox.ts) over every
// connected GlitchTip server while the app runs, polls again on focus and when the network
// returns, sends notifications, and counts what arrived since the window last had focus.

import { useCallback, useEffect, useRef, useState } from "react";
import { LazyStore } from "@tauri-apps/plugin-store";

import type { Locale } from "../i18n";
import { listIssues } from "../lib/glitchtip";
import { createKeyedLock, createPoller, sameConnection, type AlertGroup, type SeenMap, type SourceState } from "../lib/inbox";
import { notifyAlerts } from "../lib/notify";
import * as secrets from "../lib/secrets";
import { inboxSources, type InboxSource, type WorkspaceState } from "./workspace";

const store = new LazyStore("inbox.json");
// Shared by every poller the window starts, so a replaced poller and its successor take turns.
const historyLock = createKeyedLock();

function seenKey(source: InboxSource): string {
  return `seen.${source.id}.${source.verifiedAt}`;
}

export type InboxState = {
  sources: Record<string, SourceState>;
  /** Errors notified since the window last had focus. */
  unread: number;
  /** The issue the latest notification was about, so focusing the window can show it. */
  lastAlert: AlertGroup | null;
  refresh: () => Promise<void>;
};

export function useInbox(workspace: WorkspaceState | null, locale: Locale): InboxState {
  const [sources, setSources] = useState<Record<string, SourceState>>({});
  const [unread, setUnread] = useState(0);
  const [lastAlert, setLastAlert] = useState<AlertGroup | null>(null);
  const latest = useRef({ workspace, locale });
  useEffect(() => {
    latest.current = { workspace, locale };
  }, [workspace, locale]);
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
      loadSeen: async (source) => (await store.get<SeenMap>(seenKey(source))) ?? null,
      saveSeen: async (source, seen) => {
        await store.set(seenKey(source), seen);
        await store.save();
      },
      withHistory: (source, task) => historyLock(seenKey(source), task),
      onUpdate: (id, state) => {
        if (!stopped) setSources((all) => ({ ...all, [id]: state }));
      },
      onAlerts: (groups) => {
        // A poller stopped after saving what it found still reports it while that same connection
        // is there: its successor waits for that save (historyLock), compares with it and stays quiet.
        // A server removed, or added again for another organization, reports nothing late.
        const ws = latest.current.workspace;
        const id = groups[0]?.sourceId;
        if (ws === null || ws.id !== started.workspaceId) return;
        if (!sameConnection(started.sources.find((s) => s.id === id), inboxSources(ws).find((s) => s.id === id))) return;
        setUnread((n) => n + groups.reduce((sum, group) => sum + group.count, 0));
        setLastAlert(groups[0]);
        void notifyAlerts(groups, latest.current.locale).catch(() => {
          // The inbox and the menu bar still show the error.
        });
      },
    });
    pollNow.current = poller.pollNow;
    poller.start();
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
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [key]);

  const refresh = useCallback(() => pollNow.current(), []);
  return { sources, unread, lastAlert, refresh };
}
