import { describe, expect, it } from "vitest";

import type { Issue } from "./glitchtip";
import type { AlertGroup, IssueAlert } from "./inbox";
import { alertsToNotify, nativeNotification, notificationText } from "./notify";
import type { Triage } from "./triage";

const ISSUE = { id: "42", title: "TypeError: x is undefined", project: { id: "7", slug: "storefront", name: "storefront", platform: "" } } as Issue;
const BUG: Triage = { kind: "bug", priority: "important", reasons: ["crash", "own-code"] };
const OUTAGE: Triage = { kind: "outage", priority: "critical", reasons: ["dependency-down"] };
const NOISE: Triage = { kind: "noise", priority: "quiet", reasons: ["scanner"] };

function group(patch: Partial<AlertGroup> = {}): AlertGroup {
  return { sourceId: "primary", projectName: "storefront", kind: "new", count: 1, issue: ISSUE, triage: BUG, ...patch };
}

describe("notificationText", () => {
  it("names the project, says why, and shows the error for a single new one", () => {
    expect(notificationText(group(), "en")).toEqual({
      title: "New error in storefront",
      subtitle: "Nothing caught it",
      body: "TypeError: x is undefined",
    });
  });

  it("counts several and shows the leading one", () => {
    expect(notificationText(group({ kind: "regression", count: 3 }), "ru")).toEqual({
      title: "Вернулось ошибок в storefront: 3",
      subtitle: "Ошибку никто не перехватил",
      body: "TypeError: x is undefined и ещё 2",
    });
  });

  it("speaks Uzbek by default", () => {
    expect(notificationText(group({ count: 2 }), "uz").title).toBe("storefront: 2 ta yangi xato");
  });

  it("calls an outage an outage, however it arrived", () => {
    expect(notificationText(group({ triage: OUTAGE }), "en").title).toBe("Outage in storefront");
    expect(notificationText(group({ kind: "regression", triage: OUTAGE, count: 2 }), "en")).toEqual({
      title: "Outage in storefront",
      subtitle: "A service it depends on is unreachable",
      body: "TypeError: x is undefined and 1 more",
    });
  });

  it("says an error that got worse is getting worse", () => {
    const worse = group({ kind: "worse", triage: { kind: "flaky", priority: "important", reasons: ["spreading", "network"] } });
    expect(notificationText(worse, "en")).toEqual({
      title: "Getting worse in storefront",
      subtitle: "Spreading fast",
      body: "TypeError: x is undefined",
    });
    expect(notificationText({ ...worse, count: 4 }, "en").title).toBe("4 errors getting worse in storefront");
  });

  it("has no subtitle when the kind says it all", () => {
    expect(notificationText(group({ triage: { kind: "bug", priority: "important", reasons: [] } }), "en").subtitle).toBe("");
  });
});

describe("nativeNotification", () => {
  const PROVED = "2026-10-29T09:00:00Z";

  it("carries the issue's key bound to its connection, stacks by project and marks outages critical", () => {
    expect(nativeNotification(group({ triage: OUTAGE }), "en", PROVED)).toMatchObject({
      key: "primary:42@2026-10-29T09:00:00Z",
      thread: "primary:7",
      critical: true,
    });
    expect(nativeNotification(group(), "en", PROVED).critical).toBe(false);
  });

  it("offers Resolve and Ignore only when the notification is about one error", () => {
    expect(nativeNotification(group(), "en", PROVED).actions).toBe(true);
    expect(nativeNotification(group({ count: 3 }), "en", PROVED).actions).toBe(false);
  });
});

describe("alertsToNotify", () => {
  const alerts: IssueAlert[] = [
    { kind: "new", issue: ISSUE, triage: BUG },
    { kind: "new", issue: ISSUE, triage: NOISE },
    { kind: "worse", issue: ISSUE, triage: OUTAGE },
  ];

  it("keeps outages and bugs by default, everything when asked, nothing when off", () => {
    expect(alertsToNotify(alerts, "important").map((alert) => alert.triage.kind)).toEqual(["bug", "outage"]);
    expect(alertsToNotify(alerts, "all")).toHaveLength(3);
    expect(alertsToNotify(alerts, "off")).toEqual([]);
  });
});
