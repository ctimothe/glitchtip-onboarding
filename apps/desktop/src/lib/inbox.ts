// The inbox's polling and its rule for what deserves a notification.
//
// Each source's unresolved issues are read once a minute and compared with
// what the app has already seen. Only two things notify: an issue never seen
// before, and one seen closed that is open again. A known open issue that
// just gets more events updates the list quietly. The first poll of a source
// is the baseline and notifies nothing, so connecting a busy server does not
// fire every open issue at once.
//
// The seen map holds issue ids and timestamps only, never event content.

import type { Issue, IssuePage } from "./glitchtip";
import type { InboxSource } from "../app/workspace";

export type SeenEntry = {
  lastSeen: string;
  /** When the issue left a complete list (resolved or ignored); null while it is open. */
  closedAt: number | null;
};

export type SeenMap = Record<string, SeenEntry>;

export type IssueAlert = { kind: "new" | "regression"; issue: Issue };

export type AlertGroup = {
  sourceId: string;
  projectName: string;
  kind: IssueAlert["kind"];
  count: number;
  /** The most recently seen issue of the group, the one a click opens. */
  issue: Issue;
};

/** `polledAt` is when the poll that produced the state began, so a reader can tell whether it saw a change made at a known time. */
export type SourceState =
  | { status: "ok"; issues: Issue[]; polledAt: number }
  | { status: "error"; error: string; issues: Issue[]; polledAt: number };

const FORGET_CLOSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Pages read per poll: 1,000 open issues. Past that the list counts as incomplete. */
const MAX_PAGES = 10;

/**
 * Compare one poll with what was seen before. `complete` says the list holds
 * every open issue (no next page); only then does a missing issue count as
 * closed, since on a full page it may just have dropped below the cut.
 */
export function diffIssues(
  previous: SeenMap | null,
  current: Issue[],
  complete: boolean,
  now: number,
): { seen: SeenMap; alerts: IssueAlert[] } {
  const seen: SeenMap = {};
  const alerts: IssueAlert[] = [];
  for (const issue of current) {
    const before = previous?.[issue.id];
    if (previous !== null && before === undefined) alerts.push({ kind: "new", issue });
    else if (before && before.closedAt !== null) alerts.push({ kind: "regression", issue });
    seen[issue.id] = { lastSeen: issue.lastSeen, closedAt: null };
  }
  for (const [id, entry] of Object.entries(previous ?? {})) {
    if (id in seen) continue;
    const closedAt = entry.closedAt ?? (complete ? now : null);
    if (closedAt !== null && now - closedAt > FORGET_CLOSED_AFTER_MS) continue;
    seen[id] = { lastSeen: entry.lastSeen, closedAt };
  }
  return { seen, alerts };
}

/** One notification per project and kind, new issues first, the most recent issue leading each. */
export function groupAlerts(sourceId: string, alerts: IssueAlert[]): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const { kind, issue } of alerts) {
    const key = `${kind}\u0000${issue.project.id}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { sourceId, projectName: issue.project.name || issue.project.slug, kind, count: 1, issue });
      continue;
    }
    group.count += 1;
    if (issue.lastSeen > group.issue.lastSeen) group.issue = issue;
  }
  const order = { new: 0, regression: 1 } as const;
  return [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind]);
}

/** An issue in the merged inbox; `key` is unique across servers. */
export type InboxIssue = Issue & { sourceId: string; key: string };

export function issueKey(sourceId: string, issueId: string): string {
  return `${sourceId}:${issueId}`;
}

/** Every source's open issues in one list, most recently seen first, leaving out `hidden` keys. */
export function inboxIssues(states: Record<string, SourceState>, hidden: ReadonlySet<string>): InboxIssue[] {
  return Object.entries(states)
    .flatMap(([sourceId, state]) =>
      state.issues.map((issue) => ({ ...issue, sourceId, key: issueKey(sourceId, issue.id) })),
    )
    .filter((issue) => !hidden.has(issue.key))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** The projects present in the inbox, once each, by name; `key` joins source and project id. */
export function inboxProjects(issues: InboxIssue[]): Array<{ key: string; name: string }> {
  const projects = new Map<string, string>();
  for (const issue of issues) {
    projects.set(issueKey(issue.sourceId, issue.project.id), issue.project.name || issue.project.slug);
  }
  return [...projects].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export type PollerDeps = {
  sources: () => InboxSource[];
  token: (source: InboxSource) => Promise<string | null>;
  list: (baseUrl: string, token: string, org: string, cursor?: string) => Promise<IssuePage>;
  /** Keyed by the source itself, so a server re-added under a reused id starts a fresh baseline. */
  loadSeen: (source: InboxSource) => Promise<SeenMap | null>;
  saveSeen: (source: InboxSource, seen: SeenMap) => Promise<void>;
  onUpdate: (sourceId: string, state: SourceState) => void;
  onAlerts: (groups: AlertGroup[]) => void;
  /**
   * Runs one source's compare-and-save step alone, across every poller that shares it (see
   * `createKeyedLock`), so a poller replaced mid-poll and its replacement never both read the
   * same history and notify the same issue twice.
   */
  withHistory?: <T>(source: InboxSource, task: () => Promise<T>) => Promise<T>;
  now?: () => number;
  intervalMs?: number;
};

/**
 * Whether a source is still the same connection: the same id, address, organization, token and
 * verification. A server removed and added again can reuse its id for another organization.
 */
export function sameConnection(before: InboxSource | undefined, after: InboxSource | undefined): boolean {
  return (
    before !== undefined &&
    after !== undefined &&
    before.id === after.id &&
    before.baseUrl === after.baseUrl &&
    before.organizationSlug === after.organizationSlug &&
    before.tokenKey === after.tokenKey &&
    before.verifiedAt === after.verifiedAt
  );
}

/** Runs each task after every earlier task with the same key has settled. */
export function createKeyedLock(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

export type Poller = {
  start(): void;
  stop(): void;
  /** Poll every source now: on launch, wake, focus or when the network returns. */
  pollNow(): Promise<void>;
};

export function createPoller(deps: PollerDeps): Poller {
  const now = deps.now ?? Date.now;
  const withHistory = deps.withHistory ?? ((_source, task) => task());
  const inFlight = new Set<string>();
  const lastIssues = new Map<string, Issue[]>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function pollSource(source: InboxSource): Promise<void> {
    if (inFlight.has(source.id)) return;
    inFlight.add(source.id);
    const polledAt = now();
    try {
      const token = await deps.token(source);
      if (!token) {
        deps.onUpdate(source.id, { status: "error", error: "token-missing", issues: lastIssues.get(source.id) ?? [], polledAt });
        return;
      }
      const issues: Issue[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < MAX_PAGES; pages += 1) {
        const page: IssuePage = await deps.list(source.baseUrl, token, source.organizationSlug, cursor ?? undefined);
        issues.push(...page.issues);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      // A poller stopped before its turn (the servers changed) saves nothing: the poller that
      // replaces it compares with the same history, so what this read found still notifies once.
      const alerts = await withHistory(source, async () => {
        if (stopped) return null;
        const diff = diffIssues(await deps.loadSeen(source), issues, cursor === null, now());
        await deps.saveSeen(source, diff.seen);
        return diff.alerts;
      });
      if (alerts === null) return;
      lastIssues.set(source.id, issues);
      deps.onUpdate(source.id, { status: "ok", issues, polledAt });
      if (alerts.length > 0) deps.onAlerts(groupAlerts(source.id, alerts));
    } catch (err) {
      deps.onUpdate(source.id, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        issues: lastIssues.get(source.id) ?? [],
        polledAt,
      });
    } finally {
      inFlight.delete(source.id);
    }
  }

  async function pollNow(): Promise<void> {
    await Promise.all(deps.sources().map(pollSource));
  }

  return {
    start() {
      if (timer !== null) return;
      stopped = false;
      void pollNow();
      timer = setInterval(() => void pollNow(), deps.intervalMs ?? 60_000);
    },
    stop() {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    pollNow,
  };
}
