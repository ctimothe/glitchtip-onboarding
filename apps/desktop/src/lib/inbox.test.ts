import { afterEach, describe, expect, it, vi } from "vitest";

import type { Issue } from "./glitchtip";
import {
  arrivalRates,
  createKeyedLock,
  createPoller,
  diffIssues,
  evidenceQueue,
  groupAlerts,
  inboxIssues,
  inboxProjects,
  sameConnection,
  type SeenMap,
  type SignalsMap,
} from "./inbox";
import type { Signals, Triage } from "./triage";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-29T12:00:00Z");

function issue(id: string, patch: Partial<Issue> = {}): Issue {
  return {
    id,
    shortId: `APP-${id}`,
    title: `Error ${id}`,
    culprit: "",
    level: "error",
    status: "unresolved",
    count: 1,
    userCount: 1,
    firstSeen: "2026-10-29T10:00:00Z",
    lastSeen: "2026-10-29T11:00:00Z",
    errorType: "Error",
    errorValue: id,
    project: { id: "1", slug: "storefront", name: "storefront", platform: "node" },
    ...patch,
  };
}

// How an issue reads with nothing known but its title: a production bug.
const BUG: Triage = { kind: "bug", priority: "important", reasons: [] };
const CRITICAL: Triage = { kind: "outage", priority: "critical", reasons: ["dependency-down"] };
const QUIET: Triage = { kind: "noise", priority: "quiet", reasons: ["scanner"] };

const PRODUCTION: Signals = {
  environments: { production: 1 },
  users: 0,
  handled: false,
  ownCode: true,
  extension: false,
  scanner: false,
  bot: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("diffIssues", () => {
  it("takes the first poll as the baseline and alerts nothing", () => {
    const { seen, alerts } = diffIssues(null, [issue("1"), issue("2")], true, NOW);
    expect(alerts).toEqual([]);
    expect(Object.keys(seen).sort()).toEqual(["1", "2"]);
    expect(seen["1"]).toEqual({ lastSeen: "2026-10-29T11:00:00Z", closedAt: null, count: 1, at: NOW, alerted: 1 });
  });

  it("alerts once for an issue it has never seen", () => {
    const first = diffIssues(null, [issue("1")], true, NOW).seen;
    const second = diffIssues(first, [issue("2"), issue("1")], true, NOW + 60_000);
    expect(second.alerts).toEqual([{ kind: "new", issue: issue("2"), triage: BUG }]);
    expect(diffIssues(second.seen, [issue("2"), issue("1")], true, NOW + 120_000).alerts).toEqual([]);
  });

  it("does not alert when a known open issue only gets more events", () => {
    const first = diffIssues(null, [issue("1")], true, NOW).seen;
    const later = issue("1", { count: 9, lastSeen: "2026-10-29T11:59:00Z" });
    const { seen, alerts } = diffIssues(first, [later], true, NOW + 60_000);
    expect(alerts).toEqual([]);
    expect(seen["1"].lastSeen).toBe("2026-10-29T11:59:00Z");
  });

  it("marks an issue that left a complete list as closed, and alerts a regression when it returns", () => {
    const first = diffIssues(null, [issue("1")], true, NOW).seen;
    const closed = diffIssues(first, [], true, NOW + 60_000).seen;
    expect(closed["1"].closedAt).toBe(NOW + 60_000);
    const back = issue("1", { lastSeen: "2026-10-29T12:05:00Z" });
    const { seen, alerts } = diffIssues(closed, [back], true, NOW + 120_000);
    expect(alerts).toEqual([{ kind: "regression", issue: back, triage: BUG }]);
    expect(seen["1"].closedAt).toBeNull();
  });

  it("alerts once when a known open issue gets worse, and not again while it stays open", () => {
    const first = diffIssues(null, [issue("1")], true, NOW, { "1": QUIET }).seen;
    expect(first["1"].alerted).toBe(0);
    const worse = diffIssues(first, [issue("1")], true, NOW + 60_000, { "1": BUG });
    expect(worse.alerts).toEqual([{ kind: "worse", issue: issue("1"), triage: BUG }]);
    const calm = diffIssues(worse.seen, [issue("1")], true, NOW + 120_000, { "1": QUIET });
    expect(calm.alerts).toEqual([]);
    expect(diffIssues(calm.seen, [issue("1")], true, NOW + 180_000, { "1": BUG }).alerts).toEqual([]);
    expect(diffIssues(calm.seen, [issue("1")], true, NOW + 180_000, { "1": CRITICAL }).alerts).toEqual([
      { kind: "worse", issue: issue("1"), triage: CRITICAL },
    ]);
  });

  it("takes in a priority that rose only because GlitchTip was asked for the first time", () => {
    const first = diffIssues(null, [issue("1")], true, NOW, { "1": BUG }).seen;
    const { seen, alerts } = diffIssues(first, [issue("1")], true, NOW + 60_000, { "1": CRITICAL }, { "1": CRITICAL });
    expect(alerts).toEqual([]);
    expect(seen["1"].alerted).toBe(2);
  });

  it("still alerts when the error also got worse in the poll that first asked about it", () => {
    const first = diffIssues(null, [issue("1")], true, NOW, { "1": QUIET }).seen;
    // The evidence alone still reads quiet; the rise to important is the error spreading.
    const { seen, alerts } = diffIssues(first, [issue("1")], true, NOW + 60_000, { "1": BUG }, { "1": QUIET });
    expect(alerts).toEqual([{ kind: "worse", issue: issue("1"), triage: BUG }]);
    expect(seen["1"].alerted).toBe(1);
  });

  it("alerts again for an issue that returns after closing, whatever was alerted before", () => {
    const first = diffIssues(null, [issue("1")], true, NOW, { "1": CRITICAL }).seen;
    const closed = diffIssues(first, [], true, NOW + 60_000).seen;
    expect(closed["1"]).toMatchObject({ closedAt: NOW + 60_000, alerted: 2, count: 1 });
    const back = diffIssues(closed, [issue("1")], true, NOW + 120_000, { "1": QUIET });
    expect(back.alerts).toEqual([{ kind: "regression", issue: issue("1"), triage: QUIET }]);
    expect(back.seen["1"].alerted).toBe(0);
  });

  it("alerts nothing for history written before triage", () => {
    const old: SeenMap = { "1": { lastSeen: "2026-10-29T11:00:00Z", closedAt: null } };
    const { seen, alerts } = diffIssues(old, [issue("1")], true, NOW, { "1": CRITICAL });
    expect(alerts).toEqual([]);
    expect(seen["1"].alerted).toBe(2);
  });

  it("does not close an issue that only fell off a full page", () => {
    const first = diffIssues(null, [issue("1")], true, NOW).seen;
    const { seen } = diffIssues(first, [issue("2")], false, NOW + 60_000);
    expect(seen["1"].closedAt).toBeNull();
  });

  it("forgets an open issue no list has shown for thirty days, when the list is never complete", () => {
    const seen: SeenMap = {
      gone: { lastSeen: "2026-09-01T00:00:00Z", closedAt: null, count: 1, at: NOW - 31 * DAY },
      listed: { lastSeen: "2026-10-20T00:00:00Z", closedAt: null, count: 1, at: NOW - 2 * DAY },
    };
    expect(Object.keys(diffIssues(seen, [], false, NOW).seen)).toEqual(["listed"]);
  });

  it("forgets closed issues after thirty days", () => {
    const seen: SeenMap = {
      old: { lastSeen: "2026-09-01T00:00:00Z", closedAt: NOW - 31 * DAY },
      recent: { lastSeen: "2026-10-20T00:00:00Z", closedAt: NOW - 2 * DAY },
    };
    expect(Object.keys(diffIssues(seen, [], true, NOW).seen)).toEqual(["recent"]);
  });
});

describe("arrivalRates", () => {
  it("is zero on the baseline and for history without a count", () => {
    expect(arrivalRates(null, [issue("1", { count: 500 })], NOW)).toEqual({ "1": 0 });
    const old: SeenMap = { "1": { lastSeen: "2026-10-29T11:00:00Z", closedAt: null } };
    expect(arrivalRates(old, [issue("1", { count: 500 })], NOW)).toEqual({ "1": 0 });
  });

  it("counts a known issue's new events per minute since the previous poll, never over less than a minute", () => {
    const seen: SeenMap = { "1": { lastSeen: "x", closedAt: null, count: 10, at: NOW - 120_000 } };
    expect(arrivalRates(seen, [issue("1", { count: 70 })], NOW)).toEqual({ "1": 30 });
    expect(arrivalRates(seen, [issue("1", { count: 70 })], NOW - 110_000)).toEqual({ "1": 60 });
    expect(arrivalRates(seen, [issue("1", { count: 10 })], NOW)).toEqual({ "1": 0 });
  });

  it("spreads a long sleep's events over the time asleep", () => {
    const seen: SeenMap = { "1": { lastSeen: "x", closedAt: null, count: 10, at: NOW - 8 * 60 * 60_000 } };
    expect(arrivalRates(seen, [issue("1", { count: 250 })], NOW)["1"]).toBe(0.5);
  });

  it("counts an issue new to the app since it was first seen", () => {
    const fresh = issue("2", { count: 90, firstSeen: new Date(NOW - 3 * 60_000).toISOString() });
    const burst = issue("3", { count: 45, firstSeen: new Date(NOW - 5_000).toISOString() });
    const unreadable = issue("4", { count: 45, firstSeen: "" });
    expect(arrivalRates({}, [fresh, burst, unreadable], NOW)).toEqual({ "2": 30, "3": 45, "4": 0 });
  });
});

describe("evidenceQueue", () => {
  const asked = (count: number, at: number) => ({ signals: PRODUCTION, count, at });

  it("asks about everything on the baseline, newest activity first", () => {
    const older = issue("1", { lastSeen: "2026-10-29T10:00:00Z" });
    const newer = issue("2", { lastSeen: "2026-10-29T11:30:00Z" });
    expect(evidenceQueue([older, newer], null, {}, NOW).map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("puts issues about to alert first, then the unasked, then the stale, and leaves the rest", () => {
    const seen: SeenMap = {
      known: { lastSeen: "x", closedAt: null },
      back: { lastSeen: "x", closedAt: NOW - 60_000 },
      unasked: { lastSeen: "x", closedAt: null },
      doubled: { lastSeen: "x", closedAt: null },
      aged: { lastSeen: "x", closedAt: null },
      recent: { lastSeen: "x", closedAt: null },
    };
    const known: SignalsMap = {
      known: asked(5, NOW),
      back: asked(5, NOW),
      doubled: asked(5, NOW - 60_000),
      aged: asked(5, NOW - 16 * 60_000),
      recent: asked(5, NOW - 60_000),
    };
    const current = [
      issue("known", { count: 5 }),
      issue("recent", { count: 6 }),
      issue("aged", { count: 6, lastSeen: "2026-10-29T11:10:00Z" }),
      issue("doubled", { count: 10, lastSeen: "2026-10-29T11:20:00Z" }),
      issue("unasked"),
      issue("back"),
      issue("new"),
    ];
    expect(evidenceQueue(current, seen, known, NOW).map((i) => i.id)).toEqual(["back", "new", "unasked", "doubled", "aged"]);
  });
});

describe("groupAlerts", () => {
  it("makes one notification per project and kind of alert, the most serious first, led by its most serious issue", () => {
    const a = issue("1", { lastSeen: "2026-10-29T11:00:00Z" });
    const b = issue("2", { lastSeen: "2026-10-29T11:30:00Z" });
    const c = issue("3", { project: { id: "2", slug: "billing", name: "Billing", platform: "python" } });
    const d = issue("4");
    const e = issue("5", { lastSeen: "2026-10-29T10:00:00Z" });
    expect(
      groupAlerts("primary", [
        { kind: "new", issue: a, triage: BUG },
        { kind: "new", issue: c, triage: BUG },
        { kind: "regression", issue: d, triage: BUG },
        { kind: "new", issue: b, triage: BUG },
        { kind: "worse", issue: e, triage: CRITICAL },
      ]),
    ).toEqual([
      { sourceId: "primary", projectName: "storefront", kind: "worse", count: 1, issue: e, triage: CRITICAL },
      { sourceId: "primary", projectName: "storefront", kind: "new", count: 2, issue: b, triage: BUG },
      { sourceId: "primary", projectName: "Billing", kind: "new", count: 1, issue: c, triage: BUG },
      { sourceId: "primary", projectName: "storefront", kind: "regression", count: 1, issue: d, triage: BUG },
    ]);
  });

  it("leads a group with its most serious issue even when a quieter one is more recent", () => {
    const outage = issue("1", { lastSeen: "2026-10-29T11:00:00Z" });
    const noise = issue("2", { lastSeen: "2026-10-29T11:30:00Z" });
    const [group] = groupAlerts("primary", [
      { kind: "new", issue: outage, triage: CRITICAL },
      { kind: "new", issue: noise, triage: QUIET },
    ]);
    expect(group).toMatchObject({ count: 2, issue: outage, triage: CRITICAL });
  });
});

describe("createPoller", () => {
  const SOURCE = { id: "primary", verifiedAt: "2026-10-29T09:00:00Z", name: "errors.example.com", baseUrl: "https://errors.example.com", organizationSlug: "acme", tokenKey: "glitchtip-token" };

  const read = (issues: Issue[], triage: Triage = BUG) => ({
    issues,
    triage: Object.fromEntries(issues.map((i) => [i.id, triage])),
    signals: {},
  });

  function setup(token: () => Promise<string | null> = async () => "tok") {
    const store = new Map<string, SeenMap>();
    const deps = {
      sources: () => [SOURCE],
      token: vi.fn(token),
      list: vi.fn(async () => ({ issues: [issue("1")], nextCursor: null as string | null })),
      loadSeen: vi.fn(async (source: { id: string }) => store.get(source.id) ?? null),
      saveSeen: vi.fn(async (source: { id: string }, seen: SeenMap) => {
        store.set(source.id, seen);
      }),
      onUpdate: vi.fn(),
      onAlerts: vi.fn(),
      now: () => NOW,
      intervalMs: 60_000,
    };
    return { deps, store, poller: createPoller(deps) };
  }

  it("polls at once on start, then on every interval, and stops", async () => {
    vi.useFakeTimers();
    const { deps, poller } = setup();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.list).toHaveBeenCalledTimes(1);
    expect(deps.list).toHaveBeenCalledWith(SOURCE.baseUrl, "tok", "acme", undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.list).toHaveBeenCalledTimes(2);
    poller.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deps.list).toHaveBeenCalledTimes(2);
  });

  it("reports each source's issues and alerts only after the baseline", async () => {
    const { deps, poller } = setup();
    await poller.pollNow();
    expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", { status: "ok", ...read([issue("1")]), polledAt: NOW });
    expect(deps.onAlerts).not.toHaveBeenCalled();
    deps.list.mockResolvedValueOnce({ issues: [issue("2"), issue("1")], nextCursor: null });
    await poller.pollNow();
    expect(deps.onAlerts).toHaveBeenCalledWith("primary", [{ kind: "new", issue: issue("2"), triage: BUG }]);
  });

  it("reads every page before comparing, so issues past the first hundred count too", async () => {
    const { deps, poller, store } = setup();
    deps.list
      .mockResolvedValueOnce({ issues: [issue("1")], nextCursor: "c2" })
      .mockResolvedValueOnce({ issues: [issue("2")], nextCursor: null });
    await poller.pollNow();
    expect(deps.list).toHaveBeenNthCalledWith(2, SOURCE.baseUrl, "tok", "acme", "c2");
    expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", { status: "ok", ...read([issue("1"), issue("2")]), polledAt: NOW });
    expect(Object.keys(store.get("primary")!)).toEqual(["1", "2"]);
  });

  it("reports a source error without touching what it has seen", async () => {
    const { deps, poller, store } = setup();
    await poller.pollNow();
    const before = store.get("primary");
    deps.list.mockRejectedValueOnce(new Error("GET /api/0/organizations/acme/issues/ -> HTTP 401"));
    await poller.pollNow();
    expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", {
      status: "error",
      error: "GET /api/0/organizations/acme/issues/ -> HTTP 401",
      ...read([issue("1")]),
      polledAt: NOW,
    });
    expect(store.get("primary")).toBe(before);
  });

  it("reports a missing token as an error and does not call the server", async () => {
    const { deps, poller } = setup(async () => null);
    await poller.pollNow();
    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", { status: "error", error: "token-missing", ...read([]), polledAt: NOW });
  });

  it("never runs two polls of the same source at once", async () => {
    let release: () => void = () => {};
    const { deps, poller } = setup();
    deps.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ issues: [], nextCursor: null }))),
    );
    const first = poller.pollNow();
    await poller.pollNow();
    expect(deps.list).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("reads nothing more once stopped", async () => {
    const { deps, poller } = setup();
    await poller.pollNow();
    poller.stop();
    await poller.pollNow();
    expect(deps.list).toHaveBeenCalledTimes(1);
  });

  it("leaves what it has seen to the next poller once stopped, so a new issue still notifies", async () => {
    let release: () => void = () => {};
    const { deps, poller, store } = setup();
    await poller.pollNow();
    const baseline = store.get("primary");
    deps.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ issues: [issue("2"), issue("1")], nextCursor: null }))),
    );
    const stale = poller.pollNow();
    await vi.waitFor(() => expect(deps.list).toHaveBeenCalledTimes(2));
    // The servers changed while that read was out: the app stops this poller and starts another.
    poller.stop();
    release();
    await stale;
    expect(store.get("primary")).toBe(baseline);
    expect(deps.onAlerts).not.toHaveBeenCalled();
    deps.list.mockResolvedValueOnce({ issues: [issue("2"), issue("1")], nextCursor: null });
    await createPoller(deps).pollNow();
    expect(deps.onAlerts).toHaveBeenCalledWith("primary", [{ kind: "new", issue: issue("2"), triage: BUG }]);
  });

  it("notifies a new issue once when a replaced poller and its successor overlap", async () => {
    const lock = createKeyedLock();
    const { deps, store } = setup();
    const shared = { ...deps, withHistory: <T,>(source: { id: string }, task: () => Promise<T>) => lock(source.id, task) };
    await createPoller(shared).pollNow();
    deps.list.mockResolvedValue({ issues: [issue("2"), issue("1")], nextCursor: null });
    let release: () => void = () => {};
    // The old poller's history read returns late, with the history as it was when the read began.
    deps.loadSeen.mockImplementationOnce((source: { id: string }) => {
      const read = store.get(source.id) ?? null;
      return new Promise((resolve) => (release = () => resolve(read)));
    });
    const old = createPoller(shared);
    const stale = old.pollNow();
    await vi.waitFor(() => expect(deps.loadSeen).toHaveBeenCalledTimes(2));
    // The old poller already holds the history when the servers change.
    old.stop();
    const next = createPoller(shared).pollNow();
    // Its successor finishes reading the server before the old poller's history read returns.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([stale, next]);
    expect(deps.onAlerts).toHaveBeenCalledTimes(1);
    expect(deps.onAlerts).toHaveBeenCalledWith("primary", [{ kind: "new", issue: issue("2"), triage: BUG }]);
  });

  describe("with evidence from GlitchTip", () => {
    const STAGING: Signals = { ...PRODUCTION, environments: { staging: 3 } };

    function withEvidence(answer: (issue: Issue) => Signals | Promise<Signals>) {
      const base = setup();
      const signals = new Map<string, SignalsMap>();
      const deps = {
        ...base.deps,
        evidence: vi.fn(async (_source: { id: string }, _token: string, issue: Issue) => answer(issue)),
        loadSignals: vi.fn(async (source: { id: string }) => signals.get(source.id) ?? null),
        saveSignals: vi.fn(async (source: { id: string }, map: SignalsMap) => {
          signals.set(source.id, map);
        }),
      };
      return { deps, signals, store: base.store, poller: createPoller(deps) };
    }

    it("reads each issue from what its events say and reports the signals with it", async () => {
      const { deps, poller, signals } = withEvidence((i) => (i.id === "1" ? STAGING : PRODUCTION));
      deps.list.mockResolvedValue({ issues: [issue("1"), issue("2")], nextCursor: null });
      await poller.pollNow();
      expect(deps.evidence).toHaveBeenCalledTimes(2);
      expect(deps.evidence).toHaveBeenCalledWith(SOURCE, "tok", issue("1"));
      expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", {
        status: "ok",
        issues: [issue("1"), issue("2")],
        triage: {
          "1": { kind: "preproduction", priority: "quiet", reasons: ["environment"] },
          "2": { kind: "bug", priority: "important", reasons: ["crash", "own-code"] },
        },
        signals: { "1": STAGING, "2": PRODUCTION },
        polledAt: NOW,
      });
      expect(signals.get("primary")).toEqual({
        "1": { signals: STAGING, count: 1, at: NOW },
        "2": { signals: PRODUCTION, count: 1, at: NOW },
      });
    });

    it("asks about a new issue before alerting, and does not ask again while nothing changes", async () => {
      const { deps, poller } = withEvidence((i) => (i.id === "2" ? STAGING : PRODUCTION));
      await poller.pollNow();
      deps.list.mockResolvedValue({ issues: [issue("2"), issue("1")], nextCursor: null });
      await poller.pollNow();
      expect(deps.onAlerts).toHaveBeenCalledWith("primary", [
        { kind: "new", issue: issue("2"), triage: { kind: "preproduction", priority: "quiet", reasons: ["environment"] } },
      ]);
      expect(deps.evidence).toHaveBeenCalledTimes(2);
      await poller.pollNow();
      expect(deps.evidence).toHaveBeenCalledTimes(2);
    });

    it("reads an issue from its title when GlitchTip cannot be asked, and asks again next time", async () => {
      const { deps, poller } = withEvidence(() => Promise.reject(new Error("HTTP 500")));
      await poller.pollNow();
      expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", { status: "ok", ...read([issue("1")]), polledAt: NOW });
      deps.evidence.mockResolvedValueOnce(STAGING);
      await poller.pollNow();
      expect(deps.onUpdate.mock.lastCall?.[1].triage["1"].kind).toBe("preproduction");
    });

    it("alerts when a quiet issue starts spreading", async () => {
      let time = NOW;
      const { deps } = withEvidence(() => PRODUCTION);
      const hiccup = (count: number) => issue("1", { errorType: "Error", errorValue: "socket hang up", count });
      const poller = createPoller({ ...deps, now: () => time });
      deps.list.mockResolvedValue({ issues: [hiccup(3)], nextCursor: null });
      await poller.pollNow();
      time += 60_000;
      deps.list.mockResolvedValue({ issues: [hiccup(5)], nextCursor: null });
      await poller.pollNow();
      expect(deps.onAlerts).not.toHaveBeenCalled();
      time += 60_000;
      deps.list.mockResolvedValue({ issues: [hiccup(65)], nextCursor: null });
      await poller.pollNow();
      expect(deps.onAlerts).toHaveBeenCalledWith("primary", [
        { kind: "worse", issue: hiccup(65), triage: { kind: "flaky", priority: "important", reasons: ["spreading", "network"] } },
      ]);
    });

    it("alerts for a spike in the very poll that first hears about the issue", async () => {
      let time = NOW;
      const { deps } = withEvidence(() => PRODUCTION);
      const hiccup = (count: number) => issue("1", { errorType: "Error", errorValue: "socket hang up", count });
      const poller = createPoller({ ...deps, now: () => time });
      // GlitchTip cannot be asked on the baseline, so the issue is read from its title.
      deps.evidence.mockRejectedValueOnce(new Error("HTTP 500"));
      deps.list.mockResolvedValue({ issues: [hiccup(3)], nextCursor: null });
      await poller.pollNow();
      time += 60_000;
      deps.list.mockResolvedValue({ issues: [hiccup(70)], nextCursor: null });
      await poller.pollNow();
      expect(deps.onAlerts).toHaveBeenCalledWith("primary", [
        { kind: "worse", issue: hiccup(70), triage: { kind: "flaky", priority: "important", reasons: ["spreading", "network"] } },
      ]);
    });

    it("asks about at most twenty-four issues in one poll, the rest on the next", async () => {
      const { deps, poller } = withEvidence(() => PRODUCTION);
      const many = Array.from({ length: 30 }, (_, n) => issue(String(n)));
      deps.list.mockResolvedValue({ issues: many, nextCursor: null });
      await poller.pollNow();
      expect(deps.evidence).toHaveBeenCalledTimes(24);
      await poller.pollNow();
      expect(deps.evidence).toHaveBeenCalledTimes(30);
    });

    it("forgets the signals of issues it no longer remembers", async () => {
      const { deps, poller, signals, store } = withEvidence(() => PRODUCTION);
      await poller.pollNow();
      store.set("primary", {});
      deps.list.mockResolvedValue({ issues: [issue("2")], nextCursor: null });
      await poller.pollNow();
      expect(Object.keys(signals.get("primary")!)).toEqual(["2"]);
    });
  });
});

describe("createKeyedLock", () => {
  it("runs tasks with one key in turn, and tasks with other keys at once", async () => {
    const lock = createKeyedLock();
    const order: string[] = [];
    let release: () => void = () => {};
    const first = lock("a", () => new Promise<void>((resolve) => (release = () => (order.push("a1"), resolve()))));
    const second = lock("a", async () => void order.push("a2"));
    await lock("b", async () => void order.push("b1"));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["b1", "a1", "a2"]);
  });

  it("keeps going after a task fails", async () => {
    const lock = createKeyedLock();
    await expect(lock("a", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(lock("a", async () => "ok")).resolves.toBe("ok");
  });
});

describe("inboxIssues", () => {
  it("merges every source's issues, newest activity first, without the hidden ones", () => {
    const states = {
      primary: {
        status: "ok" as const,
        issues: [issue("1", { lastSeen: "2026-10-29T08:00:00Z" })],
        triage: { "1": CRITICAL },
        signals: { "1": PRODUCTION },
        polledAt: NOW,
      },
      lex: {
        status: "error" as const,
        error: "x",
        issues: [issue("2", { lastSeen: "2026-10-29T09:00:00Z" }), issue("3")],
        triage: {},
        signals: {},
        polledAt: NOW,
      },
    };
    const merged = inboxIssues(states, new Set(["lex:3"]));
    expect(merged.map((i) => [i.sourceId, i.id, i.key, i.triage, i.signals])).toEqual([
      ["lex", "2", "lex:2", BUG, null],
      ["primary", "1", "primary:1", CRITICAL, PRODUCTION],
    ]);
  });

  it("lists each source's projects once, by name", () => {
    const merged = inboxIssues(
      {
        primary: {
          status: "ok",
          issues: [issue("1"), issue("2"), issue("3", { project: { id: "2", slug: "bank", name: "Billing", platform: "" } })],
          triage: {},
          signals: {},
          polledAt: NOW,
        },
      },
      new Set(),
    );
    expect(inboxProjects(merged)).toEqual([
      { key: "primary:2", name: "Billing" },
      { key: "primary:1", name: "storefront" },
    ]);
  });
});

describe("sameConnection", () => {
  const SOURCE = { id: "errors-example-org", verifiedAt: "2026-10-29T09:00:00Z", name: "errors.example.org", baseUrl: "https://errors.example.org", organizationSlug: "acme", tokenKey: "glitchtip-token.errors-example-org" };

  it("holds only while the id, address, organization, token and verification all match", () => {
    expect(sameConnection(SOURCE, { ...SOURCE, name: "renamed" })).toBe(true);
    expect(sameConnection(SOURCE, { ...SOURCE, organizationSlug: "other" })).toBe(false);
    expect(sameConnection(SOURCE, { ...SOURCE, verifiedAt: "2026-11-04T09:00:00Z" })).toBe(false);
    expect(sameConnection(SOURCE, { ...SOURCE, baseUrl: "https://errors.example.net" })).toBe(false);
    expect(sameConnection(SOURCE, undefined)).toBe(false);
    expect(sameConnection(undefined, SOURCE)).toBe(false);
  });
});
