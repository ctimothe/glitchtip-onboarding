// The inbox's polling and its rule for what deserves a notification.
//
// Each source's unresolved issues are read once a minute, read for how real they are (./triage)
// and compared with what the app has already seen. Three things alert: an issue never seen
// before, one seen closed that is open again, and a known open one that got worse (its priority
// rose above what was last alerted: it started spreading, or reached real people). A known open
// issue that just gets more events updates the list quietly. The first poll of a source is the
// baseline and alerts nothing, so connecting a busy server does not fire every open issue at once.
// Which alerts become notifications is the caller's choice (src/app/inbox-state.ts).
//
// What is kept between polls holds issue ids, counts, timestamps and yes/no signals only, never
// event content.

import type { Issue, IssuePage } from "./glitchtip";
import { classify, PRIORITY_RANK, type Signals, type Triage } from "./triage";
import type { InboxSource } from "../app/workspace";

export type SeenEntry = {
  lastSeen: string;
  /** When the issue left a complete list (resolved or ignored); null while it is open. */
  closedAt: number | null;
  /** The events counted at the last poll and when that was, for the arrival rate. Missing in entries written before triage. */
  count?: number;
  at?: number;
  /** The highest priority already alerted while the issue has been open (PRIORITY_RANK). */
  alerted?: 0 | 1 | 2;
};

export type SeenMap = Record<string, SeenEntry>;

/** What each issue's events said when GlitchTip was last asked, and the event count and time of asking. */
export type SignalsMap = Record<string, { signals: Signals; count: number; at: number }>;

export type IssueAlert = { kind: "new" | "regression" | "worse"; issue: Issue; triage: Triage };

export type AlertGroup = {
  sourceId: string;
  projectName: string;
  kind: IssueAlert["kind"];
  count: number;
  /** The group's most serious issue, the most recently seen among equals: the one a click opens. */
  issue: Issue;
  triage: Triage;
};

/**
 * `polledAt` is when the poll that produced the state began, so a reader can tell whether it saw a
 * change made at a known time. `triage` has an entry for every issue; `signals` only for those
 * GlitchTip has been asked about.
 */
export type SourceState = {
  issues: Issue[];
  triage: Record<string, Triage>;
  signals: Record<string, Signals>;
  polledAt: number;
} & ({ status: "ok" } | { status: "error"; error: string });

const FORGET_CLOSED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Pages read per poll: 1,000 open issues. Past that the list counts as incomplete. */
const MAX_PAGES = 10;
/** Issues GlitchTip is asked about per poll and server, two requests each, this many at a time. */
const EVIDENCE_PER_POLL = 24;
const EVIDENCE_AT_ONCE = 4;
/** An issue with new events is asked about again after this long, or at once when its events doubled. */
const EVIDENCE_REFRESH_MS = 15 * 60 * 1000;

/**
 * Events per minute for each open issue: since the previous poll, or since it was first seen for
 * one new to the app. Zero on the baseline and wherever the history has no count to compare with.
 */
export function arrivalRates(previous: SeenMap | null, current: Issue[], now: number): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const issue of current) {
    const before = previous?.[issue.id];
    let events = 0;
    let since = now;
    if (previous !== null && before === undefined) {
      events = issue.count;
      since = Date.parse(issue.firstSeen);
    } else if (before?.count !== undefined && before.at !== undefined) {
      events = issue.count - before.count;
      since = before.at;
    }
    const minutes = Math.max(1, (now - since) / 60_000);
    rates[issue.id] = events > 0 && Number.isFinite(minutes) ? events / minutes : 0;
  }
  return rates;
}

/**
 * Which issues to ask GlitchTip about, most urgent first: those about to alert (new to the app or
 * back after closing), then those never asked about, then those whose answer is stale. Newest
 * activity first within each.
 */
export function evidenceQueue(current: Issue[], previous: SeenMap | null, known: SignalsMap, now: number): Issue[] {
  const alerting: Issue[] = [];
  const unasked: Issue[] = [];
  const stale: Issue[] = [];
  for (const issue of current) {
    const before = previous?.[issue.id];
    const asked = known[issue.id];
    if (previous !== null && (before === undefined || before.closedAt !== null)) alerting.push(issue);
    else if (asked === undefined) unasked.push(issue);
    else if (issue.count >= asked.count * 2 || (issue.count > asked.count && now - asked.at >= EVIDENCE_REFRESH_MS)) stale.push(issue);
  }
  const newestFirst = (a: Issue, b: Issue) => b.lastSeen.localeCompare(a.lastSeen);
  return [...alerting.sort(newestFirst), ...unasked.sort(newestFirst), ...stale.sort(newestFirst)];
}

/**
 * Compare one poll with what was seen before. `complete` says the list holds
 * every open issue (no next page); only then does a missing issue count as
 * closed, since on a full page it may just have dropped below the cut.
 *
 * `triage` is this poll's reading of each issue. `learned` holds, for each issue GlitchTip was
 * asked about for the first time in this poll, how it reads from that evidence alone, with no
 * arrival rate: a priority that rises only that far is taken in silently, since nothing about the
 * error itself changed. A rise beyond it (the error is also spreading) still alerts.
 */
export function diffIssues(
  previous: SeenMap | null,
  current: Issue[],
  complete: boolean,
  now: number,
  triage: Record<string, Triage> = {},
  learned: Record<string, Triage> = {},
): { seen: SeenMap; alerts: IssueAlert[] } {
  const seen: SeenMap = {};
  const alerts: IssueAlert[] = [];
  for (const issue of current) {
    const before = previous?.[issue.id];
    const read = triage[issue.id] ?? classify(issue, null);
    const rank = PRIORITY_RANK[read.priority];
    let alerted = rank;
    if (previous !== null && before === undefined) alerts.push({ kind: "new", issue, triage: read });
    else if (before && before.closedAt !== null) alerts.push({ kind: "regression", issue, triage: read });
    else if (before) {
      const known = learned[issue.id] ? PRIORITY_RANK[learned[issue.id].priority] : 0;
      const alertedBefore = before.alerted ?? rank;
      const had = known > alertedBefore ? known : alertedBefore;
      if (rank > had) alerts.push({ kind: "worse", issue, triage: read });
      alerted = rank > had ? rank : had;
    }
    seen[issue.id] = { lastSeen: issue.lastSeen, closedAt: null, count: issue.count, at: now, alerted };
  }
  for (const [id, entry] of Object.entries(previous ?? {})) {
    if (id in seen) continue;
    const closedAt = entry.closedAt ?? (complete ? now : null);
    if (closedAt !== null && now - closedAt > FORGET_CLOSED_AFTER_MS) continue;
    // Past a thousand open issues the list is never complete and nothing is ever seen closing:
    // an issue not listed for thirty days is forgotten all the same.
    if (closedAt === null && entry.at !== undefined && now - entry.at > FORGET_CLOSED_AFTER_MS) continue;
    seen[id] = { ...entry, closedAt };
  }
  return { seen, alerts };
}

/**
 * One notification per project and kind of alert, led by its most serious issue (the most recent
 * among equals). The most serious groups come first, then new before returning before worse.
 */
export function groupAlerts(sourceId: string, alerts: IssueAlert[]): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  const rank = (triage: Triage) => PRIORITY_RANK[triage.priority];
  for (const { kind, issue, triage } of alerts) {
    const key = `${kind}\u0000${issue.project.id}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { sourceId, projectName: issue.project.name || issue.project.slug, kind, count: 1, issue, triage });
      continue;
    }
    group.count += 1;
    if (rank(triage) > rank(group.triage) || (rank(triage) === rank(group.triage) && issue.lastSeen > group.issue.lastSeen)) {
      group.issue = issue;
      group.triage = triage;
    }
  }
  const order = { new: 0, regression: 1, worse: 2 } as const;
  return [...groups.values()].sort((a, b) => rank(b.triage) - rank(a.triage) || order[a.kind] - order[b.kind]);
}

/** An issue in the merged inbox; `key` is unique across servers. `signals` is null until GlitchTip has been asked about it. */
export type InboxIssue = Issue & { sourceId: string; key: string; triage: Triage; signals: Signals | null };

export function issueKey(sourceId: string, issueId: string): string {
  return `${sourceId}:${issueId}`;
}

/** Every source's open issues in one list, most recently seen first, leaving out `hidden` keys. */
export function inboxIssues(states: Record<string, SourceState>, hidden: ReadonlySet<string>): InboxIssue[] {
  return Object.entries(states)
    .flatMap(([sourceId, state]) =>
      state.issues.map((issue) => ({
        ...issue,
        sourceId,
        key: issueKey(sourceId, issue.id),
        triage: state.triage[issue.id] ?? classify(issue, null),
        signals: state.signals[issue.id] ?? null,
      })),
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
  /**
   * What one issue's events say (`issueEvidence` read by `readSignals`). Without it, or when it
   * rejects, the issue is read from its title alone and counts as production.
   */
  evidence?: (source: InboxSource, token: string, issue: Issue) => Promise<Signals>;
  loadSignals?: (source: InboxSource) => Promise<SignalsMap | null>;
  saveSignals?: (source: InboxSource, signals: SignalsMap) => Promise<void>;
  onUpdate: (sourceId: string, state: SourceState) => void;
  /** Every alert of one poll of one source, quiet ones included; never called with none. */
  onAlerts: (sourceId: string, alerts: IssueAlert[]) => void;
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
  const last = new Map<string, Pick<SourceState, "issues" | "triage" | "signals">>();
  const nothing = { issues: [], triage: {}, signals: {} };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  /** Ask GlitchTip about the issues at the head of the queue; returns this poll's answers. */
  async function gather(source: InboxSource, token: string, issues: Issue[]): Promise<SignalsMap> {
    const answers: SignalsMap = {};
    const evidence = deps.evidence;
    if (!evidence) return answers;
    const known = (await deps.loadSignals?.(source)) ?? {};
    const queue = evidenceQueue(issues, await deps.loadSeen(source), known, now()).slice(0, EVIDENCE_PER_POLL);
    async function worker() {
      for (let issue = queue.shift(); issue !== undefined && !stopped; issue = queue.shift()) {
        try {
          answers[issue.id] = { signals: await evidence!(source, token, issue), count: issue.count, at: now() };
        } catch {
          // Read from its title for now; the next poll asks again.
        }
      }
    }
    await Promise.all(Array.from({ length: EVIDENCE_AT_ONCE }, worker));
    return answers;
  }

  async function pollSource(source: InboxSource): Promise<void> {
    // A poller the app has replaced reads nothing more, whatever still calls it.
    if (stopped || inFlight.has(source.id)) return;
    inFlight.add(source.id);
    const polledAt = now();
    try {
      const token = await deps.token(source);
      if (!token) {
        deps.onUpdate(source.id, { status: "error", error: "token-missing", ...(last.get(source.id) ?? nothing), polledAt });
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
      const answers = await gather(source, token, issues);
      // A poller stopped before its turn (the servers changed) saves nothing: the poller that
      // replaces it compares with the same history, so what this read found still notifies once.
      const known: SignalsMap = {};
      const result = await withHistory(source, async () => {
        if (stopped) return null;
        const previous = await deps.loadSeen(source);
        // Read again under the lock, so answers another poller saved meanwhile are kept.
        const stored = (await deps.loadSignals?.(source)) ?? {};
        const firstAnswers = new Set(Object.keys(answers).filter((id) => !(id in stored)));
        Object.assign(known, stored, answers);
        const rates = arrivalRates(previous, issues, now());
        const triage: Record<string, Triage> = {};
        const learned: Record<string, Triage> = {};
        for (const issue of issues) {
          const signals = known[issue.id]?.signals ?? null;
          triage[issue.id] = classify(issue, signals, { rate: rates[issue.id] });
          if (firstAnswers.has(issue.id)) learned[issue.id] = classify(issue, signals);
        }
        const diff = diffIssues(previous, issues, cursor === null, now(), triage, learned);
        await deps.saveSeen(source, diff.seen);
        // Kept for as long as the issue is remembered, so one that returns is read at once.
        const kept: SignalsMap = {};
        for (const id of Object.keys(known)) if (id in diff.seen) kept[id] = known[id];
        await deps.saveSignals?.(source, kept);
        return { alerts: diff.alerts, triage };
      });
      if (result === null) return;
      const signals: Record<string, Signals> = {};
      for (const issue of issues) if (known[issue.id]) signals[issue.id] = known[issue.id].signals;
      last.set(source.id, { issues, triage: result.triage, signals });
      deps.onUpdate(source.id, { status: "ok", issues, triage: result.triage, signals, polledAt });
      if (result.alerts.length > 0) deps.onAlerts(source.id, result.alerts);
    } catch (err) {
      deps.onUpdate(source.id, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        ...(last.get(source.id) ?? nothing),
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
