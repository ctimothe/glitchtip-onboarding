import { afterEach, describe, expect, it, vi } from "vitest";

import type { Issue } from "./glitchtip";
import { createKeyedLock, createPoller, diffIssues, groupAlerts, inboxIssues, inboxProjects, sameConnection, type SeenMap } from "./inbox";

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
    project: { id: "1", slug: "storefront", name: "storefront" },
    ...patch,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("diffIssues", () => {
  it("takes the first poll as the baseline and alerts nothing", () => {
    const { seen, alerts } = diffIssues(null, [issue("1"), issue("2")], true, NOW);
    expect(alerts).toEqual([]);
    expect(Object.keys(seen).sort()).toEqual(["1", "2"]);
    expect(seen["1"]).toEqual({ lastSeen: "2026-10-29T11:00:00Z", closedAt: null });
  });

  it("alerts once for an issue it has never seen", () => {
    const first = diffIssues(null, [issue("1")], true, NOW).seen;
    const second = diffIssues(first, [issue("2"), issue("1")], true, NOW + 60_000);
    expect(second.alerts).toEqual([{ kind: "new", issue: issue("2") }]);
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
    expect(alerts).toEqual([{ kind: "regression", issue: back }]);
    expect(seen["1"].closedAt).toBeNull();
  });

  it("does not close an issue that only fell off a full page", () => {
    const first = diffIssues(null, [issue("1")], true, NOW).seen;
    const { seen } = diffIssues(first, [issue("2")], false, NOW + 60_000);
    expect(seen["1"].closedAt).toBeNull();
  });

  it("forgets closed issues after thirty days", () => {
    const seen: SeenMap = {
      old: { lastSeen: "2026-09-01T00:00:00Z", closedAt: NOW - 31 * DAY },
      recent: { lastSeen: "2026-10-20T00:00:00Z", closedAt: NOW - 2 * DAY },
    };
    expect(Object.keys(diffIssues(seen, [], true, NOW).seen)).toEqual(["recent"]);
  });
});

describe("groupAlerts", () => {
  it("makes one notification per project, new before returning, with the newest first", () => {
    const a = issue("1", { lastSeen: "2026-10-29T11:00:00Z" });
    const b = issue("2", { lastSeen: "2026-10-29T11:30:00Z" });
    const c = issue("3", { project: { id: "2", slug: "billing", name: "Billing" } });
    const d = issue("4");
    expect(
      groupAlerts("primary", [
        { kind: "new", issue: a },
        { kind: "new", issue: c },
        { kind: "regression", issue: d },
        { kind: "new", issue: b },
      ]),
    ).toEqual([
      { sourceId: "primary", projectName: "storefront", kind: "new", count: 2, issue: b },
      { sourceId: "primary", projectName: "Billing", kind: "new", count: 1, issue: c },
      { sourceId: "primary", projectName: "storefront", kind: "regression", count: 1, issue: d },
    ]);
  });
});

describe("createPoller", () => {
  const SOURCE = { id: "primary", verifiedAt: "2026-10-29T09:00:00Z", name: "errors.example.com", baseUrl: "https://errors.example.com", organizationSlug: "acme", tokenKey: "glitchtip-token" };

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
    expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", { status: "ok", issues: [issue("1")], polledAt: NOW });
    expect(deps.onAlerts).not.toHaveBeenCalled();
    deps.list.mockResolvedValueOnce({ issues: [issue("2"), issue("1")], nextCursor: null });
    await poller.pollNow();
    expect(deps.onAlerts).toHaveBeenCalledWith([
      { sourceId: "primary", projectName: "storefront", kind: "new", count: 1, issue: issue("2") },
    ]);
  });

  it("reads every page before comparing, so issues past the first hundred count too", async () => {
    const { deps, poller, store } = setup();
    deps.list
      .mockResolvedValueOnce({ issues: [issue("1")], nextCursor: "c2" })
      .mockResolvedValueOnce({ issues: [issue("2")], nextCursor: null });
    await poller.pollNow();
    expect(deps.list).toHaveBeenNthCalledWith(2, SOURCE.baseUrl, "tok", "acme", "c2");
    expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", { status: "ok", issues: [issue("1"), issue("2")], polledAt: NOW });
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
      issues: [issue("1")],
      polledAt: NOW,
    });
    expect(store.get("primary")).toBe(before);
  });

  it("reports a missing token as an error and does not call the server", async () => {
    const { deps, poller } = setup(async () => null);
    await poller.pollNow();
    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.onUpdate).toHaveBeenLastCalledWith("primary", { status: "error", error: "token-missing", issues: [], polledAt: NOW });
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
    expect(deps.onAlerts).toHaveBeenCalledWith([
      { sourceId: "primary", projectName: "storefront", kind: "new", count: 1, issue: issue("2") },
    ]);
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
    expect(deps.onAlerts).toHaveBeenCalledWith([
      { sourceId: "primary", projectName: "storefront", kind: "new", count: 1, issue: issue("2") },
    ]);
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
      primary: { status: "ok" as const, issues: [issue("1", { lastSeen: "2026-10-29T08:00:00Z" })], polledAt: NOW },
      lex: {
        status: "error" as const,
        error: "x",
        issues: [issue("2", { lastSeen: "2026-10-29T09:00:00Z" }), issue("3")],
        polledAt: NOW,
      },
    };
    const merged = inboxIssues(states, new Set(["lex:3"]));
    expect(merged.map((i) => [i.sourceId, i.id, i.key])).toEqual([
      ["lex", "2", "lex:2"],
      ["primary", "1", "primary:1"],
    ]);
  });

  it("lists each source's projects once, by name", () => {
    const merged = inboxIssues(
      {
        primary: {
          status: "ok",
          issues: [issue("1"), issue("2"), issue("3", { project: { id: "2", slug: "bank", name: "Billing" } })],
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
