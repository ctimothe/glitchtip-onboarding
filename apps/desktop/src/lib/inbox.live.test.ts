// @vitest-environment node
//
// The inbox against a real GlitchTip: the corpus of ordinary production errors
// (test/live-glitchtip/corpus.mjs) goes in through the ingest endpoint, and the app's own poller,
// client and triage read it back. Skipped unless LIVE_GLITCHTIP_URL names the local server that
// test/live-glitchtip/run.sh starts; `./scripts/check` does not run it.

import { beforeAll, describe, expect, it } from "vitest";

import { SCENARIOS, type Scenario } from "../../../../test/live-glitchtip/corpus.mjs";
import { buildEvent, ensureProjects, fire, ORG, send, TOKEN } from "../../../../test/live-glitchtip/seed.mjs";
import { issueEvidence, listIssues, setIssueStatus, type Issue } from "./glitchtip";
import { createPoller, type IssueAlert, type SeenMap, type SignalsMap, type SourceState } from "./inbox";
import { readSignals } from "./triage";

const BASE = process.env.LIVE_GLITCHTIP_URL ?? "";
const SOURCE = { id: "primary", verifiedAt: "live", name: "local", baseUrl: BASE, organizationSlug: ORG, tokenKey: "glitchtip-token" };
// GlitchTip groups and counts events after it accepts them.
const SETTLE_MS = 30_000;

const titleOf = (scenario: Scenario) => scenario.message ?? scenario.value ?? "";
const matches = (issue: Issue, scenario: Scenario) =>
  scenario.message !== undefined ? issue.title === scenario.message : issue.errorType === scenario.type && issue.errorValue === scenario.value;

async function until<T>(read: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("the local GlitchTip did not settle in time");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function openIssues(): Promise<Issue[]> {
  const issues: Issue[] = [];
  let cursor: string | undefined;
  do {
    const page = await listIssues(BASE, TOKEN, ORG, { cursor });
    issues.push(...page.issues);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return issues;
}

/** The app's poller with its real client and nothing else: history and signals stay in memory. */
function inbox() {
  let seen: SeenMap | null = null;
  let signals: SignalsMap | null = null;
  let state: SourceState | null = null;
  const alerts: IssueAlert[] = [];
  const poller = createPoller({
    sources: () => [SOURCE],
    token: async () => TOKEN,
    list: (baseUrl, token, org, cursor) => listIssues(baseUrl, token, org, { cursor }),
    evidence: async (source, token, issue) => readSignals(await issueEvidence(source.baseUrl, token, issue), issue.project.platform),
    loadSeen: async () => seen,
    saveSeen: async (_source, next) => void (seen = next),
    loadSignals: async () => signals,
    saveSignals: async (_source, next) => void (signals = next),
    onUpdate: (_id, next) => void (state = next),
    onAlerts: (_id, found) => void alerts.push(...found),
  });
  return {
    alerts,
    /** Poll until GlitchTip has been asked about every open issue (24 per poll). */
    async poll(): Promise<SourceState & { status: "ok" }> {
      for (;;) {
        await poller.pollNow();
        const current = state as SourceState | null;
        if (current === null || current.status !== "ok") throw new Error(`poll failed: ${JSON.stringify(current)}`);
        if (current.issues.every((issue) => issue.id in current.signals)) return current;
      }
    },
  };
}

describe.skipIf(BASE === "")("the inbox against a real GlitchTip", () => {
  beforeAll(async () => {
    const present = await openIssues();
    const missing = SCENARIOS.filter((scenario) => !present.some((issue) => matches(issue, scenario)));
    if (missing.length > 0) await fire({ only: missing.map((scenario) => scenario.id) });
    await until(async () => {
      const issues = await openIssues();
      return SCENARIOS.every((scenario) => issues.some((issue) => matches(issue, scenario) && issue.count >= scenario.events));
    });
  }, 120_000);

  it("reads every scenario of the corpus as the corpus says a developer would", async () => {
    const live = inbox();
    const state = await live.poll();
    const read = SCENARIOS.map((scenario) => {
      const issue = state.issues.find((candidate) => matches(candidate, scenario));
      const triage = issue ? state.triage[issue.id] : null;
      return { id: scenario.id, kind: triage?.kind, priority: triage?.priority };
    });
    expect(read).toEqual(SCENARIOS.map((scenario) => ({ id: scenario.id, ...scenario.expect })));
    // Connecting a server alerts nothing, whatever is open on it.
    expect(live.alerts).toEqual([]);
  }, 120_000);

  it("counts people from the events, which GlitchTip's own userCount does not", async () => {
    const state = await inbox().poll();
    for (const scenario of SCENARIOS.filter((s) => s.users > 0)) {
      const issue = state.issues.find((candidate) => matches(candidate, scenario))!;
      expect([scenario.id, state.signals[issue.id].users]).toEqual([scenario.id, scenario.users]);
    }
  }, 120_000);

  it("alerts for a new outage, for an error that returns after Resolve, and for a hiccup that starts spreading", async () => {
    const live = inbox();
    await live.poll();
    const projects = await ensureProjects();
    const run = Date.now().toString(36);

    // A database that was never down before.
    const outage: Scenario = { ...SCENARIOS.find((s) => s.id === "api-database-refused")!, value: `connect ECONNREFUSED 10.0.9.${run}:5432` };
    for (let n = 0; n < 5; n += 1) await send(projects[outage.project], buildEvent(outage, n));
    await until(async () => (await openIssues()).some((issue) => matches(issue, outage) && issue.count >= 5));
    await live.poll();
    expect(live.alerts.map((alert) => [alert.kind, alert.issue.errorValue, alert.triage.kind, alert.triage.priority])).toEqual([
      ["new", titleOf(outage), "outage", "critical"],
    ]);

    // Resolve it in GlitchTip the way the inbox does; one more event reopens it.
    live.alerts.length = 0;
    const resolved = (await openIssues()).find((issue) => matches(issue, outage))!;
    await setIssueStatus(BASE, TOKEN, ORG, resolved.id, "resolved");
    await live.poll();
    expect(live.alerts).toEqual([]);
    await send(projects[outage.project], buildEvent(outage, 0));
    await until(async () => (await openIssues()).some((issue) => issue.id === resolved.id));
    await live.poll();
    expect(live.alerts.map((alert) => [alert.kind, alert.issue.id, alert.triage.priority])).toEqual([["regression", resolved.id, "critical"]]);

    // The payment provider's occasional timeout becomes forty in a minute.
    live.alerts.length = 0;
    const hiccup = SCENARIOS.find((s) => s.id === "api-payment-timeout")!;
    const before = (await openIssues()).find((issue) => matches(issue, hiccup))!;
    for (let n = 0; n < 40; n += 1) await send(projects[hiccup.project], buildEvent(hiccup, n));
    await until(async () => (await openIssues()).some((issue) => issue.id === before.id && issue.count >= before.count + 40));
    await live.poll();
    expect(live.alerts.map((alert) => [alert.kind, alert.issue.id, alert.triage.kind, alert.triage.reasons])).toEqual([
      ["worse", before.id, "flaky", ["spreading", "network"]],
    ]);
  }, 180_000);
});
