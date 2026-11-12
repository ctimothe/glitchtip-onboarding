import { describe, expect, it, vi, afterEach } from "vitest";
import {
  ALERT_RULE_NAME,
  checkInstance,
  fetchInventory,
  issueUrl,
  issueEvidence,
  issueTags,
  latestEvent,
  projectDsn,
  listIssues,
  provisionInventory,
  setIssueStatus,
  type Inventory,
} from "./glitchtip";

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function expectGetOnly(calls: { init?: RequestInit }[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(
      call.init?.method === undefined || call.init?.method === "GET",
    ).toBe(true);
  }
}

describe("checkInstance", () => {
  it("normalizes a trailing slash before probing openapi.json", async () => {
    const { fetchFn, calls } = recordingFetch(() =>
      jsonResponse(200, { info: { title: "GlitchTip API" } }),
    );
    const info = await checkInstance("https://errors.example.com/", fetchFn);
    expect(info.url).toBe("https://errors.example.com");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://errors.example.com/api/0/openapi.json",
    );
  });

  it("falls back to /api/openapi.json where /api/0/openapi.json is missing (app.glitchtip.com)", async () => {
    const { fetchFn, calls } = recordingFetch((url) =>
      url.endsWith("/api/0/openapi.json")
        ? jsonResponse(404, { detail: "Not found" })
        : jsonResponse(200, { openapi: "3.1.0", info: { title: "GlitchTip API" } }),
    );
    const info = await checkInstance("https://app.glitchtip.com", fetchFn);
    expect(info.glitchtipTitle).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://app.glitchtip.com/api/0/openapi.json",
      "https://app.glitchtip.com/api/openapi.json",
    ]);
  });

  it("does not fall back when the first schema is not GlitchTip's", async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, { info: { title: "Something Else" } }));
    await expect(checkInstance("https://errors.example.com", fetchFn)).rejects.toThrow("not-a-glitchtip-instance");
    expect(calls).toHaveLength(1);
  });

  it("returns title confirmation and latency on 200 + GlitchTip title", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, {
        openapi: "3.1.0",
        info: { title: "GlitchTip API", version: "6.2.0" },
      }),
    );
    const info = await checkInstance("https://errors.example.com", fetchFn);
    expect(info).toEqual({
      url: "https://errors.example.com",
      glitchtipTitle: true,
      latencyMs: expect.any(Number),
    });
    expect(info.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("accepts a top-level title shape", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, { title: "GlitchTip API" }),
    );
    const info = await checkInstance("https://errors.example.com", fetchFn);
    expect(info.glitchtipTitle).toBe(true);
  });

  it("throws not-a-glitchtip-instance on 200 + wrong title", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, { info: { title: "Something Else" } }),
    );
    await expect(checkInstance("https://errors.example.com", fetchFn)).rejects.toThrow(
      "not-a-glitchtip-instance",
    );
  });

  it("throws not-a-glitchtip-instance on non-200", async () => {
    const { fetchFn } = recordingFetch(() => jsonResponse(404, {}));
    await expect(checkInstance("https://errors.example.com", fetchFn)).rejects.toThrow(
      "not-a-glitchtip-instance",
    );
  });

  it("throws not-a-glitchtip-instance on network failure", async () => {
    const { fetchFn } = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(checkInstance("https://errors.example.com", fetchFn)).rejects.toThrow(
      "not-a-glitchtip-instance",
    );
  });

  it("aborts the probe after the timeout window", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null = null;
    const { fetchFn } = recordingFetch((_url, init) => {
      observedSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const pending = expect(
      checkInstance("https://errors.example.com", fetchFn),
    ).rejects.toThrow("not-a-glitchtip-instance");
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(observedSignal).not.toBeNull();
  });

  it("never uses a mutating HTTP method", async () => {
    const { fetchFn, calls } = recordingFetch(() =>
      jsonResponse(200, { info: { title: "GlitchTip API" } }),
    );
    await checkInstance("https://errors.example.com", fetchFn);
    expectGetOnly(calls);
  });

  it("falls back to /api/settings/ when neither schema path answers", async () => {
    const { fetchFn, calls } = recordingFetch((url) =>
      url.endsWith("/api/settings/")
        ? jsonResponse(200, { iPaidForGlitchTip: false, enableOrganizationCreation: false })
        : jsonResponse(404, {}),
    );
    const info = await checkInstance("https://errors.example.com", fetchFn);
    expect(info.glitchtipTitle).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://errors.example.com/api/0/openapi.json",
      "https://errors.example.com/api/openapi.json",
      "https://errors.example.com/api/settings/",
    ]);
    expectGetOnly(calls);
  });

  it("rejects settings that are not GlitchTip's", async () => {
    const { fetchFn } = recordingFetch((url) =>
      url.endsWith("/api/settings/") ? jsonResponse(200, { theme: "dark" }) : jsonResponse(404, {}),
    );
    await expect(checkInstance("https://errors.example.com", fetchFn)).rejects.toThrow(
      "not-a-glitchtip-instance",
    );
  });
});

describe("fetchInventory", () => {
  const ORG = "workspace";

  function inventoryFetch(state: {
    teams?: { slug: string }[];
    projects?: { slug: string }[];
    keys?: { dsn?: { public?: string } }[];
    alerts?: { name?: string }[];
    orgStatus?: number;
  }) {
    return recordingFetch((url) => {
      if (url.endsWith(`/api/0/organizations/${ORG}/`)) {
        return jsonResponse(state.orgStatus ?? 200, { slug: ORG });
      }
      if (url.endsWith(`/api/0/organizations/${ORG}/teams/`)) {
        return jsonResponse(200, state.teams ?? [{ slug: ORG }]);
      }
      if (url.endsWith(`/api/0/organizations/${ORG}/projects/`)) {
        return jsonResponse(200, state.projects ?? [{ slug: "myapp" }]);
      }
      if (url.includes("/keys/")) {
        return jsonResponse(200, state.keys ?? [{ dsn: { public: "x" } }]);
      }
      if (url.includes("/alerts/")) {
        return jsonResponse(200, state.alerts ?? [{ name: "x" }]);
      }
      return jsonResponse(404, {});
    });
  }

  it("maps a fully provisioned org to the Inventory shape", async () => {
    const { fetchFn } = inventoryFetch({});
    const inv: Inventory = await fetchInventory(
      "https://errors.example.com/",
      "token-1",
      ORG,
      fetchFn,
    );
    expect(inv).toEqual({
      org: ORG,
      team: ORG,
      project: "myapp",
      key: true,
      alertRule: true,
      teams: [ORG],
      projects: ["myapp"],
    });
  });

  it("maps missing resources to nulls and falses", async () => {
    const { fetchFn } = inventoryFetch({ projects: [], keys: [], alerts: [] });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
    );
    expect(inv).toEqual({
      org: ORG,
      team: ORG,
      project: null,
      key: false,
      alertRule: false,
      teams: [ORG],
      projects: [],
    });
  });

  it("reports a missing org as an empty inventory without further probing", async () => {
    const { fetchFn, calls } = inventoryFetch({ orgStatus: 404 });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
    );
    expect(inv).toEqual({
      org: null,
      team: null,
      project: null,
      key: false,
      alertRule: false,
      teams: [],
      projects: [],
    });
    expect(calls).toHaveLength(1);
  });

  it("throws on auth failure instead of reporting empty", async () => {
    const { fetchFn } = inventoryFetch({ orgStatus: 401 });
    await expect(
      fetchInventory("https://errors.example.com", "bad-token", ORG, fetchFn),
    ).rejects.toThrow();
  });

  it("sends the bearer token on every call and never mutates", async () => {
    const { fetchFn, calls } = inventoryFetch({});
    await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer token-1");
      expect(call.init?.method === undefined || call.init?.method === "GET").toBe(
        true,
      );
    }
  });

  it("prefers the org-named team but returns every team for selection", async () => {
    const { fetchFn } = inventoryFetch({
      teams: [{ slug: "frontend" }, { slug: ORG }, { slug: "backend" }],
    });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
    );
    expect(inv.team).toBe(ORG);
    expect(inv.teams).toEqual(["frontend", ORG, "backend"]);
  });

  it("falls back to the first team when no org-named team exists", async () => {
    const { fetchFn } = inventoryFetch({
      teams: [{ slug: "frontend" }, { slug: "backend" }],
    });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
    );
    expect(inv.team).toBe("frontend");
    expect(inv.teams).toEqual(["frontend", "backend"]);
  });

  it("returns every project while defaulting to the first", async () => {
    const { fetchFn } = inventoryFetch({
      projects: [{ slug: "web" }, { slug: "api" }],
    });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
    );
    expect(inv.project).toBe("web");
    expect(inv.projects).toEqual(["web", "api"]);
  });

  it("converges key/alert evidence onto the explicitly selected project", async () => {
    const seen: string[] = [];
    const { fetchFn } = recordingFetch((url) => {
      seen.push(url);
      if (url.endsWith(`/api/0/organizations/${ORG}/`)) {
        return jsonResponse(200, { slug: ORG });
      }
      if (url.endsWith(`/api/0/organizations/${ORG}/teams/`)) {
        return jsonResponse(200, [{ slug: ORG }, { slug: "backend" }]);
      }
      if (url.endsWith(`/api/0/organizations/${ORG}/projects/`)) {
        return jsonResponse(200, [{ slug: "web" }, { slug: "api" }]);
      }
      // Only the selected project reports a key and an alert rule.
      if (url.includes("/projects/workspace/api/keys/")) {
        return jsonResponse(200, [{ dsn: { public: "x" } }]);
      }
      if (url.includes("/projects/workspace/api/alerts/")) {
        return jsonResponse(200, [{ name: ALERT_RULE_NAME }]);
      }
      if (url.includes("/keys/")) return jsonResponse(200, []);
      if (url.includes("/alerts/")) return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
      { team: "backend", project: "api" },
    );
    expect(inv.team).toBe("backend");
    expect(inv.project).toBe("api");
    expect(inv.key).toBe(true);
    expect(inv.alertRule).toBe(true);
    expect(inv.teams).toEqual([ORG, "backend"]);
    expect(inv.projects).toEqual(["web", "api"]);
    expect(seen.some((u) => u.includes("/projects/workspace/api/keys/"))).toBe(true);
  });
  it("reports a named-but-missing project verbatim with key/alert false", async () => {
    // Keys/alerts for an unknown project slug answer 404, like the server.
    const { fetchFn } = recordingFetch((url) => {
      if (url.endsWith(`/api/0/organizations/${ORG}/`)) {
        return jsonResponse(200, { slug: ORG });
      }
      if (url.endsWith(`/api/0/organizations/${ORG}/teams/`)) {
        return jsonResponse(200, [{ slug: ORG }]);
      }
      if (url.endsWith(`/api/0/organizations/${ORG}/projects/`)) {
        return jsonResponse(200, [{ slug: "myapp" }]);
      }
      return jsonResponse(404, {});
    });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      ORG,
      fetchFn,
      { project: "brand-new" },
    );
    expect(inv.project).toBe("brand-new");
    expect(inv.key).toBe(false);
    expect(inv.alertRule).toBe(false);
  });

  it("encodes org/team/project slugs in request URLs", async () => {
    const seen: string[] = [];
    const { fetchFn } = recordingFetch((url) => {
      seen.push(url);
      if (url.endsWith("/api/0/organizations/my%20org/")) {
        return jsonResponse(200, { slug: "my org" });
      }
      if (url.endsWith("/api/0/organizations/my%20org/teams/")) {
        return jsonResponse(200, [{ slug: "team a" }]);
      }
      if (url.endsWith("/api/0/organizations/my%20org/projects/")) {
        return jsonResponse(200, [{ slug: "proj/x" }]);
      }
      if (url.includes("/projects/my%20org/proj%2Fx/keys/")) {
        return jsonResponse(200, []);
      }
      if (url.includes("/projects/my%20org/proj%2Fx/alerts/")) {
        return jsonResponse(200, []);
      }
      return jsonResponse(404, {});
    });
    const inv = await fetchInventory(
      "https://errors.example.com",
      "token-1",
      "my org",
      fetchFn,
      { team: "team a", project: "proj/x" },
    );
    expect(inv.team).toBe("team a");
    expect(inv.project).toBe("proj/x");
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect(url).not.toContain("my org");
      expect(url).not.toContain("proj/x");
    }
    expect(seen.some((u) => u.includes("/projects/my%20org/proj%2Fx/keys/"))).toBe(true);
  });
});

describe("provisionInventory", () => {
  const BASE = "https://errors.example.com";
  const ORG = "workspace";
  const REQ = {
    team: ORG,
    project: "myapp",
    projectName: "My App",
    platform: "other",
    webhookUrl: "http://relay:8090/",
  };

  type Route = { method: string; status: number; body: unknown };

  function provisionFetch(routes: Record<string, Route | ((body: unknown) => Route)>) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const path = href.replace(BASE, "");
      const route = routes[path];
      const resolved =
        typeof route === "function"
          ? route(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
          : (route ?? { method: "GET", status: 404, body: {} });
      calls.push({ method, url: href, body: init?.body });
      void resolved.method;
      return {
        ok: resolved.status >= 200 && resolved.status < 300,
        status: resolved.status,
        json: async () => resolved.body,
      } as unknown as Response;
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  function fullState() {
    return provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: ORG }],
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: "myapp" }],
      },
      [`/api/0/projects/${ORG}/myapp/keys/`]: {
        method: "GET",
        status: 200,
        body: [{ dsn: { public: "x" } }],
      },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: {
        method: "GET",
        status: 200,
        body: [{ id: 7, name: ALERT_RULE_NAME, alertRecipients: [{ recipientType: "webhook", url: REQ.webhookUrl }] }],
      },
    });
  }

  it("reports all-existed when everything is already present (idempotent)", async () => {
    const { fetchFn, calls } = fullState();
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "org:existed",
      "team:existed",
      "project:existed",
      "key:existed",
      "alert:existed",
    ]);
    expect(calls.every((c) => c.method === "GET" || c.method === undefined)).toBe(true);
  });

  function existingRule(recipients: unknown[], put: (body: unknown) => Route) {
    const { fetchFn, calls } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: { method: "GET", status: 200, body: [{ slug: ORG }] },
      [`/api/0/organizations/${ORG}/projects/`]: { method: "GET", status: 200, body: [{ slug: "myapp" }] },
      [`/api/0/projects/${ORG}/myapp/keys/`]: { method: "GET", status: 200, body: [{ dsn: { public: "x" } }] },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: {
        method: "GET",
        status: 200,
        body: [{ id: 12, name: ALERT_RULE_NAME, alertRecipients: recipients }],
      },
      [`/api/0/projects/${ORG}/myapp/alerts/12/`]: put,
    });
    return { fetchFn, calls };
  }

  it("points an existing rule that sends elsewhere at the relay, keeping its other recipients", async () => {
    const sent: unknown[] = [];
    const { fetchFn, calls } = existingRule(
      [
        { id: 1, recipientType: "webhook", url: "http://old-mac-relay.local:8787/webhook" },
        { id: 2, recipientType: "email", url: "" },
      ],
      (body) => {
        sent.push(body);
        return { method: "PUT", status: 200, body: { id: 12 } };
      },
    );
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "updated" });
    expect(calls.find((c) => c.url.endsWith("/alerts/12/"))?.method).toBe("PUT");
    // Only the recipients are sent, so GlitchTip keeps the rule's name and thresholds.
    expect(sent).toEqual([
      {
        alertRecipients: [
          { recipientType: "email", url: "" },
          { recipientType: "webhook", url: "http://relay:8090/" },
        ],
      },
    ]);
  });

  it("fails the alert step when the rule cannot be pointed at the relay", async () => {
    const { fetchFn } = existingRule([{ recipientType: "webhook", url: "http://old/" }], () => ({
      method: "PUT",
      status: 403,
      body: {},
    }));
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "failed" });
    expect(steps[4].evidence).toContain("HTTP 403");
  });

  it("keeps every setting of the recipients it does not replace", async () => {
    const sent: unknown[] = [];
    const { fetchFn } = existingRule(
      [
        { id: 1, recipientType: "webhook", url: "http://old/", config: null, tagsToAdd: null },
        { id: 2, recipientType: "discord", url: "https://discord.example/hook", config: null, tagsToAdd: ["server_name"] },
        {
          id: 3,
          recipientType: "zulip",
          url: "https://zulip.example",
          config: { bot_email: "bot@zulip.example", api_key: "zulip-key", channel: "ops", topic: "Errors" },
          tagsToAdd: null,
        },
      ],
      (body) => {
        sent.push(body);
        return { method: "PUT", status: 200, body: { id: 12 } };
      },
    );
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "updated" });
    expect(sent).toEqual([
      {
        alertRecipients: [
          { recipientType: "discord", url: "https://discord.example/hook", tagsToAdd: ["server_name"] },
          {
            recipientType: "zulip",
            url: "https://zulip.example",
            botEmail: "bot@zulip.example",
            apiKey: "zulip-key",
            channel: "ops",
            topic: "Errors",
          },
          { recipientType: "webhook", url: "http://relay:8090/" },
        ],
      },
    ]);
  });

  it.each([
    ["a type it does not know", { recipientType: "pagerduty", url: "https://pd.example" }],
    ["a Zulip recipient listed without its settings", { recipientType: "zulip", url: "https://zulip.example", config: {} }],
  ])("leaves the rule unchanged when it has %s", async (_, recipient) => {
    const { fetchFn, calls } = existingRule([{ recipientType: "webhook", url: "http://old/" }, recipient], () => ({
      method: "PUT",
      status: 200,
      body: {},
    }));
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "failed" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("leaves a rule that sends elsewhere unchanged until asked to switch it", async () => {
    const { fetchFn, calls } = existingRule([{ recipientType: "webhook", url: "http://old/" }], () => ({
      method: "PUT",
      status: 200,
      body: {},
    }));
    const steps = await provisionInventory(BASE, "token-1", ORG, { ...REQ, switchExisting: false }, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "pending" });
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("names GlitchTip's refusal of a webhook to a private address", async () => {
    const refusal = { detail: [{ loc: ["body", "url"], msg: "Value error, URLs targeting private or internal IPs are not allowed" }] };
    const { fetchFn } = existingRule([{ recipientType: "webhook", url: "http://old/" }], () => ({
      method: "PUT",
      status: 422,
      body: refusal,
    }));
    const updated = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(updated[4]).toMatchObject({ step: "alert", status: "failed", reason: "private-webhooks" });

    const { fetchFn: createFetch } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: { method: "GET", status: 200, body: [{ slug: ORG }] },
      [`/api/0/organizations/${ORG}/projects/`]: { method: "GET", status: 200, body: [{ slug: "myapp" }] },
      [`/api/0/projects/${ORG}/myapp/keys/`]: { method: "GET", status: 200, body: [{ dsn: { public: "x" } }] },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: (body) =>
        body === undefined ? { method: "GET", status: 200, body: [] } : { method: "POST", status: 422, body: refusal },
    });
    const created = await provisionInventory(BASE, "token-1", ORG, REQ, createFetch);
    expect(created[4]).toMatchObject({ step: "alert", status: "failed", reason: "private-webhooks" });
  });

  it("does not read another 422 as a private-address refusal", async () => {
    const { fetchFn } = existingRule([{ recipientType: "webhook", url: "http://old/" }], () => ({
      method: "PUT",
      status: 422,
      body: { detail: [{ msg: "Field required" }] },
    }));
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[4].reason).toBeUndefined();
  });

  it("creates the team via POST /api/0/organizations/{org}/teams/ when missing", async () => {
    const { fetchFn, calls } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: (body) => {
        if (body !== undefined) return { method: "POST", status: 201, body: { slug: ORG } };
        return { method: "GET", status: 200, body: [{ slug: "other" }] };
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: "myapp" }],
      },
      [`/api/0/projects/${ORG}/myapp/keys/`]: {
        method: "GET",
        status: 200,
        body: [{ dsn: { public: "x" } }],
      },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: {
        method: "GET",
        status: 200,
        body: [{ id: 7, name: ALERT_RULE_NAME, alertRecipients: [{ recipientType: "webhook", url: REQ.webhookUrl }] }],
      },
    });
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[1]).toMatchObject({ step: "team", status: "created" });
    const post = calls.find(
      (c) => c.url.endsWith(`/api/0/organizations/${ORG}/teams/`) && c.method === "POST",
    );
    expect(post).toBeDefined();
    expect(String(post?.body)).toContain(ORG);
  });

  it("creates the project on the TEAM endpoint (org projects is GET-only)", async () => {
    const { fetchFn, calls } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: ORG }],
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [],
      },
      [`/api/0/teams/${ORG}/${ORG}/projects/`]: {
        method: "POST",
        status: 201,
        body: { slug: "myapp" },
      },
      [`/api/0/projects/${ORG}/myapp/keys/`]: (body) => {
        if (body !== undefined) return { method: "POST", status: 201, body: {} };
        return { method: "GET", status: 200, body: [] };
      },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: {
        method: "GET",
        status: 200,
        body: [{ id: 7, name: ALERT_RULE_NAME, alertRecipients: [{ recipientType: "webhook", url: REQ.webhookUrl }] }],
      },
    });
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[2]).toMatchObject({ step: "project", status: "created" });
    expect(
      calls.some(
        (c) =>
          c.url.endsWith(`/api/0/teams/${ORG}/${ORG}/projects/`) && c.method === "POST",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.url.endsWith(`/api/0/organizations/${ORG}/projects/`) && c.method === "POST",
      ),
    ).toBe(false);
  });

  it("creates a key only when the project has none", async () => {
    const { fetchFn, calls } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: ORG }],
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: "myapp" }],
      },
      [`/api/0/projects/${ORG}/myapp/keys/`]: (body) => {
        if (body !== undefined) return { method: "POST", status: 201, body: {} };
        return { method: "GET", status: 200, body: [] };
      },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: {
        method: "GET",
        status: 200,
        body: [{ id: 7, name: ALERT_RULE_NAME, alertRecipients: [{ recipientType: "webhook", url: REQ.webhookUrl }] }],
      },
    });
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[3]).toMatchObject({ step: "key", status: "created" });
    expect(
      calls.some(
        (c) => c.url.includes("/keys/") && c.method === "POST",
      ),
    ).toBe(true);
  });

  it("posts the alert rule with a webhook recipient and reuses it by name", async () => {
    const posted: unknown[] = [];
    const { fetchFn } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: ORG }],
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: "myapp" }],
      },
      [`/api/0/projects/${ORG}/myapp/keys/`]: {
        method: "GET",
        status: 200,
        body: [{ dsn: { public: "x" } }],
      },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: (body) => {
        if (body !== undefined) {
          posted.push(body);
          return { method: "POST", status: 201, body: { pk: 7 } };
        }
        return { method: "GET", status: 200, body: [] };
      },
    });
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "created" });
    expect(steps[4].evidence).toContain("id 7");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      name: ALERT_RULE_NAME,
      alertRecipients: [{ recipientType: "webhook", url: "http://relay:8090/" }],
    });
  });

  it("posts gallery preset thresholds through the same alert rule body", async () => {
    const posted: unknown[] = [];
    const { fetchFn } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: ORG }],
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: "myapp" }],
      },
      [`/api/0/projects/${ORG}/myapp/keys/`]: {
        method: "GET",
        status: 200,
        body: [{ dsn: { public: "x" } }],
      },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: (body) => {
        if (body !== undefined) {
          posted.push(body);
          return { method: "POST", status: 201, body: { pk: 8 } };
        }
        return { method: "GET", status: 200, body: [] };
      },
    });
    // quiet preset: 10 events within 60 minutes (templates.ts ALERT_PRESETS).
    const steps = await provisionInventory(BASE, "token-1", ORG, {
      ...REQ,
      quantity: 10,
      timespanMinutes: 60,
    }, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "created" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      name: ALERT_RULE_NAME,
      quantity: 10,
      timespanMinutes: 60,
      alertRecipients: [{ recipientType: "webhook", url: "http://relay:8090/" }],
    });
  });

  it("falls back to the chatty rule when preset numbers are not positive", async () => {
    const posted: unknown[] = [];
    const { fetchFn } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: ORG }],
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: "myapp" }],
      },
      [`/api/0/projects/${ORG}/myapp/keys/`]: {
        method: "GET",
        status: 200,
        body: [{ dsn: { public: "x" } }],
      },
      [`/api/0/projects/${ORG}/myapp/alerts/`]: (body) => {
        if (body !== undefined) {
          posted.push(body);
          return { method: "POST", status: 201, body: { pk: 9 } };
        }
        return { method: "GET", status: 200, body: [] };
      },
    });
    const steps = await provisionInventory(BASE, "token-1", ORG, {
      ...REQ,
      quantity: 0,
      timespanMinutes: -5,
    }, fetchFn);
    expect(steps[4]).toMatchObject({ step: "alert", status: "created" });
    expect(posted[0]).toMatchObject({ quantity: 1, timespanMinutes: 10 });
  });

  it("skips the alert step when no relay URL is given", async () => {
    const { fetchFn } = fullState();
    const steps = await provisionInventory(
      BASE,
      "token-1",
      ORG,
      { ...REQ, webhookUrl: "" },
      fetchFn,
    );
    expect(steps[4]).toMatchObject({ step: "alert", status: "skipped" });
  });

  it("fails the org step without creating anything when the org is missing", async () => {
    const { fetchFn, calls } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 404, body: {} },
    });
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: "org", status: "failed" });
    expect(calls.every((c) => c.method === "GET" || c.method === undefined)).toBe(true);
  });

  it("stops at the first failure and reports evidence", async () => {
    const { fetchFn, calls } = provisionFetch({
      [`/api/0/organizations/${ORG}/`]: { method: "GET", status: 200, body: { slug: ORG } },
      [`/api/0/organizations/${ORG}/teams/`]: {
        method: "GET",
        status: 200,
        body: [{ slug: ORG }],
      },
      [`/api/0/organizations/${ORG}/projects/`]: {
        method: "GET",
        status: 200,
        body: [],
      },
      [`/api/0/teams/${ORG}/${ORG}/projects/`]: {
        method: "POST",
        status: 403,
        body: { detail: "forbidden" },
      },
    });
    const steps = await provisionInventory(BASE, "token-1", ORG, REQ, fetchFn);
    expect(steps.map((s) => s.step)).toEqual(["org", "team", "project"]);
    expect(steps[2]).toMatchObject({ step: "project", status: "failed" });
    expect(steps[2].evidence).toContain(
      `POST /api/0/teams/${ORG}/${ORG}/projects/`,
    );
    expect(calls.some((c) => c.url.includes("/keys/"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/alerts/"))).toBe(false);
  });
});

function responseWithLink(status: number, body: unknown, link: string | null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(link === null ? {} : { Link: link }),
    json: async () => body,
  } as unknown as Response;
}

const ISSUE = {
  id: "42",
  shortId: "STOREFRONT-1A",
  title: "TypeError: x is undefined",
  culprit: "app/routes/case.ts in load",
  level: "error",
  status: "unresolved",
  count: "17",
  userCount: 3,
  firstSeen: "2026-10-28T08:00:00Z",
  lastSeen: "2026-10-29T09:30:00Z",
  metadata: { type: "TypeError", value: "x is undefined", filename: "app/routes/case.ts", function: "load" },
  project: { id: "7", slug: "storefront", name: "storefront", platform: "javascript-react" },
  // GlitchTip 6.2.0 builds this from the project slug, a page that does not exist; it is ignored.
  permalink: "https://errors.example.com/storefront/issues/42",
};

describe("listIssues", () => {
  it("asks for unresolved issues, newest activity first, and maps them", async () => {
    const { fetchFn, calls } = recordingFetch(() => responseWithLink(200, [ISSUE], null));
    const page = await listIssues("https://errors.example.com/", "tok", "acme corp", {}, fetchFn);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/0/organizations/acme%20corp/issues/");
    expect(url.searchParams.get("query")).toBe("is:unresolved");
    expect(url.searchParams.get("sort")).toBe("-last_seen");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer tok");
    expectGetOnly(calls);
    expect(page.nextCursor).toBeNull();
    expect(page.issues).toEqual([
      {
        id: "42",
        shortId: "STOREFRONT-1A",
        title: "TypeError: x is undefined",
        culprit: "app/routes/case.ts in load",
        level: "error",
        status: "unresolved",
        count: 17,
        userCount: 3,
        firstSeen: "2026-10-28T08:00:00Z",
        lastSeen: "2026-10-29T09:30:00Z",
        errorType: "TypeError",
        errorValue: "x is undefined",
        project: { id: "7", slug: "storefront", name: "storefront", platform: "javascript-react" },
      },
    ]);
  });

  it("leaves the exception empty for an issue that is a plain message", async () => {
    const message = { ...ISSUE, title: "Retrying charge_invoice", metadata: {}, project: { id: "7", slug: "worker", name: "worker" } };
    const { fetchFn } = recordingFetch(() => responseWithLink(200, [message, { ...message, id: "43", metadata: null }], null));
    const page = await listIssues("https://errors.example.com", "tok", "acme", {}, fetchFn);
    expect(page.issues.map((issue) => [issue.errorType, issue.errorValue, issue.project.platform])).toEqual([
      ["", "", ""],
      ["", "", ""],
    ]);
  });

  it("passes the cursor and reads the next one from the Link header", async () => {
    const link =
      '<https://errors.example.com/api/0/organizations/acme/issues/?cursor=a>; rel="previous"; results="false"; cursor="a", ' +
      '<https://errors.example.com/api/0/organizations/acme/issues/?cursor=b>; rel="next"; results="true"; cursor="b"';
    const { fetchFn, calls } = recordingFetch(() => responseWithLink(200, [ISSUE], link));
    const page = await listIssues("https://errors.example.com", "tok", "acme", { cursor: "a" }, fetchFn);
    expect(new URL(calls[0].url).searchParams.get("cursor")).toBe("a");
    expect(page.nextCursor).toBe("b");
  });

  it("reads the next cursor from the Link header exactly as GlitchTip 6.2.0 sends it", async () => {
    const link =
      "{'<http://localhost:8765/api/0/organizations/livecheck/issues/?limit=100>; rel=\"previous\"; results=\"false\", " +
      '<http://localhost:8765/api/0/organizations/livecheck/issues/?cursor=cD0y&limit=100>; rel="next"; results="true"; cursor="cD0y"\'}';
    const { fetchFn } = recordingFetch(() => responseWithLink(200, [ISSUE], link));
    const page = await listIssues("https://errors.example.com", "tok", "livecheck", {}, fetchFn);
    expect(page.nextCursor).toBe("cD0y");
  });

  it("reports no next page when the next link has no results", async () => {
    const link = '<https://x/?cursor=b>; rel="next"; results="false"; cursor="b"';
    const { fetchFn } = recordingFetch(() => responseWithLink(200, [], link));
    const page = await listIssues("https://errors.example.com", "tok", "acme", {}, fetchFn);
    expect(page.nextCursor).toBeNull();
  });

  it("skips entries without an id or title instead of failing the page", async () => {
    const { fetchFn } = recordingFetch(() =>
      responseWithLink(200, [ISSUE, { id: 5 }, null, { ...ISSUE, id: "43", count: "oops" }], null),
    );
    const page = await listIssues("https://errors.example.com", "tok", "acme", {}, fetchFn);
    expect(page.issues.map((issue) => [issue.id, issue.count])).toEqual([
      ["42", 17],
      ["43", 0],
    ]);
  });

  it("throws with the status when the server refuses", async () => {
    const { fetchFn } = recordingFetch(() => responseWithLink(401, { detail: "no" }, null));
    await expect(listIssues("https://errors.example.com", "tok", "acme", {}, fetchFn)).rejects.toThrow(
      "GET /api/0/organizations/acme/issues/ -> HTTP 401",
    );
  });
});

describe("latestEvent", () => {
  it("reads the latest event and keeps exceptions, frames, tags and release", async () => {
    const { fetchFn, calls } = recordingFetch(() =>
      jsonResponse(200, {
        eventID: "abc",
        dateCreated: "2026-10-29T09:30:00Z",
        message: "",
        release: { version: "1.4.0" },
        tags: [{ key: "environment", value: "production" }, { key: 1 }],
        entries: [
          { type: "breadcrumbs", data: { values: [] } },
          {
            type: "exception",
            data: {
              values: [
                {
                  type: "TypeError",
                  value: "x is undefined",
                  mechanism: { type: "onerror", handled: false },
                  stacktrace: {
                    frames: [
                      { filename: "node_modules/lib.js", function: "run", lineNo: 1, colNo: 2, inApp: false },
                      {
                        filename: "/app/routes/case.js",
                        absPath: "https://shop.example.com/app/routes/case.js",
                        function: "load",
                        lineNo: 42,
                        colNo: 7,
                        inApp: true,
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: "request",
            data: { url: "https://shop.example.com/cart", method: null, headers: [["Accept", "*/*"], ["User-Agent", "Mozilla/5.0 Safari"]] },
          },
        ],
      }),
    );
    const event = await latestEvent("https://errors.example.com", "tok", "42", fetchFn);
    expect(calls[0].url).toBe("https://errors.example.com/api/0/issues/42/events/latest/");
    expectGetOnly(calls);
    expect(event).toEqual({
      eventId: "abc",
      dateCreated: "2026-10-29T09:30:00Z",
      message: "",
      release: "1.4.0",
      tags: [{ key: "environment", value: "production" }],
      exceptions: [
        {
          type: "TypeError",
          value: "x is undefined",
          frames: [
            {
              filename: "/app/routes/case.js",
              absPath: "https://shop.example.com/app/routes/case.js",
              function: "load",
              lineNo: 42,
              colNo: 7,
              inApp: true,
            },
            { filename: "node_modules/lib.js", absPath: "", function: "run", lineNo: 1, colNo: 2, inApp: false },
          ],
        },
      ],
      handled: false,
      request: { url: "https://shop.example.com/cart", userAgent: "Mozilla/5.0 Safari" },
    });
  });

  it("says nothing about handling or the request when the event carries neither", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, { eventID: "abc", entries: [{ type: "exception", data: { values: [{ type: "KeyError", value: "'id'" }] } }] }),
    );
    const event = await latestEvent("https://errors.example.com", "tok", "42", fetchFn);
    expect(event.handled).toBeNull();
    expect(event.request).toBeNull();
  });

  it("calls a chain a crash when any of its exceptions went uncaught", async () => {
    const values = [
      { type: "ValueError", value: "bad", mechanism: { type: "chained", handled: true } },
      { type: "RuntimeError", value: "worse", mechanism: { type: "celery", handled: false } },
    ];
    const { fetchFn } = recordingFetch(() => jsonResponse(200, { eventID: "abc", entries: [{ type: "exception", data: { values } }] }));
    expect((await latestEvent("https://errors.example.com", "tok", "42", fetchFn)).handled).toBe(false);
  });

  it("reads the release from its tag when the event has no release object, as GlitchTip 6.2.0 sends it", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(200, {
        eventID: "abc",
        dateCreated: "2026-11-01T09:30:00Z",
        message: "",
        tags: [
          { key: "environment", value: "production" },
          { key: "release", value: "livecheck@1.0.0" },
        ],
        entries: [],
      }),
    );
    const event = await latestEvent("https://errors.example.com", "tok", "42", fetchFn);
    expect(event.release).toBe("livecheck@1.0.0");
  });

  it("throws with the status when the event cannot be read", async () => {
    const { fetchFn } = recordingFetch(() => jsonResponse(404, {}));
    await expect(latestEvent("https://errors.example.com", "tok", "42", fetchFn)).rejects.toThrow(
      "GET /api/0/issues/42/events/latest/ -> HTTP 404",
    );
  });
});

// As GlitchTip 6.2.0 answers GET /api/0/issues/{id}/tags/ (read from a local server on 2026-11-12).
const TAGS = [
  { key: "browser.name", name: "browser.name", uniqueValues: 2, totalValues: 23, topValues: [{ name: "Mobile Safari", value: "Mobile Safari", count: 20, key: "browser.name" }, { name: "Chrome", value: "Chrome", count: 3, key: "browser.name" }] },
  { key: "user.id", name: "user.id", uniqueValues: 17, totalValues: 23, topValues: [{ name: "u-1", value: "u-1", count: 2, key: "user.id" }] },
  { key: "environment", name: "environment", uniqueValues: 2, totalValues: 23, topValues: [{ name: "production", value: "production", count: 21, key: "environment" }, { name: "staging", value: "staging", count: 2, key: "environment" }] },
];

describe("issueTags", () => {
  it("reads each tag's distinct count and most frequent values", async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, [...TAGS, { key: 7 }, null]));
    const tags = await issueTags("https://errors.example.com/", "tok", "16", fetchFn);
    expect(calls[0].url).toBe("https://errors.example.com/api/0/issues/16/tags/");
    expectGetOnly(calls);
    expect(tags).toEqual([
      { key: "browser.name", unique: 2, values: [{ value: "Mobile Safari", count: 20 }, { value: "Chrome", count: 3 }] },
      { key: "user.id", unique: 17, values: [{ value: "u-1", count: 2 }] },
      { key: "environment", unique: 2, values: [{ value: "production", count: 21 }, { value: "staging", count: 2 }] },
    ]);
  });

  it("has no tags for a server without the endpoint, and throws when refused", async () => {
    const missing = recordingFetch(() => jsonResponse(404, { detail: "Not found" }));
    expect(await issueTags("https://errors.example.com", "tok", "16", missing.fetchFn)).toEqual([]);
    const refused = recordingFetch(() => jsonResponse(401, {}));
    await expect(issueTags("https://errors.example.com", "tok", "16", refused.fetchFn)).rejects.toThrow(
      "GET /api/0/issues/16/tags/ -> HTTP 401",
    );
  });
});

describe("issueEvidence", () => {
  const EVENT = {
    eventID: "abc",
    tags: [{ key: "environment", value: "staging" }],
    entries: [
      {
        type: "exception",
        data: {
          values: [
            { type: "Error", value: "outer cause", stacktrace: { frames: [{ filename: "a.js", inApp: true }] } },
            {
              type: "TypeError",
              value: "x is undefined",
              mechanism: { type: "onerror", handled: false },
              stacktrace: {
                frames: [
                  { filename: "/framework.js", absPath: "https://shop.example.com/framework.js", inApp: false },
                  { filename: "/content.js", absPath: "chrome-extension://abc/content.js", inApp: false },
                ],
              },
            },
          ],
        },
      },
      { type: "request", data: { url: "https://shop.example.com/cart", headers: [["user-agent", "Mozilla/5.0 Safari"]] } },
    ],
  };

  it("joins the latest event with the tag counts, reading only", async () => {
    const { fetchFn, calls } = recordingFetch((url) => jsonResponse(200, url.endsWith("/tags/") ? TAGS : EVENT));
    const evidence = await issueEvidence("https://errors.example.com", "tok", { id: "16", count: 23 }, fetchFn);
    expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual([
      "/api/0/issues/16/events/latest/",
      "/api/0/issues/16/tags/",
    ]);
    expectGetOnly(calls);
    expect(evidence).toEqual({
      environments: [{ name: "production", count: 21 }, { name: "staging", count: 2 }],
      browsers: [{ name: "Mobile Safari", count: 20 }, { name: "Chrome", count: 3 }],
      users: 17,
      handled: false,
      userAgent: "Mozilla/5.0 Safari",
      url: "https://shop.example.com/cart",
      frames: [
        { file: "chrome-extension://abc/content.js", inApp: false },
        { file: "https://shop.example.com/framework.js", inApp: false },
      ],
    });
  });

  it("reports the events the environment tag does not account for as naming none", async () => {
    const { fetchFn } = recordingFetch((url) => jsonResponse(200, url.endsWith("/tags/") ? TAGS : EVENT));
    // Thirty events, twenty-three of them labelled: seven name no environment.
    const evidence = await issueEvidence("https://errors.example.com", "tok", { id: "16", count: 30 }, fetchFn);
    expect(evidence.environments).toEqual([
      { name: "production", count: 21 },
      { name: "staging", count: 2 },
      { name: "", count: 7 },
    ]);
  });

  it("counts a latest event without an environment even when every counted one is labelled", async () => {
    const staging = [{ key: "environment", uniqueValues: 1, totalValues: 4, topValues: [{ value: "staging", count: 4 }] }];
    const unlabelled = { ...EVENT, tags: [] };
    const { fetchFn } = recordingFetch((url) => jsonResponse(200, url.endsWith("/tags/") ? staging : unlabelled));
    const evidence = await issueEvidence("https://errors.example.com", "tok", { id: "16", count: 4 }, fetchFn);
    expect(evidence.environments).toEqual([{ name: "staging", count: 4 }, { name: "", count: 1 }]);
  });

  it("knows only the latest event's environment when the server counts no tags, and says so", async () => {
    const { fetchFn } = recordingFetch((url) => (url.endsWith("/tags/") ? jsonResponse(404, {}) : jsonResponse(200, EVENT)));
    const evidence = await issueEvidence("https://errors.example.com", "tok", { id: "16", count: 5 }, fetchFn);
    expect(evidence.environments).toEqual([{ name: "staging", count: 1 }, { name: "", count: 4 }]);
    expect(evidence.users).toBe(0);
    expect(evidence.browsers).toEqual([]);
  });

  it("fails when the event cannot be read", async () => {
    const { fetchFn } = recordingFetch((url) => (url.endsWith("/tags/") ? jsonResponse(200, TAGS) : jsonResponse(500, {})));
    await expect(issueEvidence("https://errors.example.com", "tok", { id: "16", count: 1 }, fetchFn)).rejects.toThrow("HTTP 500");
  });
});

describe("setIssueStatus", () => {
  it("puts the new status on the organization's issue", async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, { ...ISSUE, status: "resolved" }));
    await setIssueStatus("https://errors.example.com", "tok", "acme", "42", "resolved", fetchFn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://errors.example.com/api/0/organizations/acme/issues/42/");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ status: "resolved" });
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("throws with the status when the change is refused", async () => {
    const { fetchFn } = recordingFetch(() => jsonResponse(403, {}));
    await expect(
      setIssueStatus("https://errors.example.com", "tok", "acme", "42", "ignored", fetchFn),
    ).rejects.toThrow("PUT /api/0/organizations/acme/issues/42/ -> HTTP 403");
  });
});

describe("authenticated requests", () => {
  it("refuse redirects, so the token never follows one to another host", async () => {
    const { fetchFn, calls } = recordingFetch(() => responseWithLink(200, [], null));
    await listIssues("https://errors.example.com", "tok", "acme", {}, fetchFn);
    await setIssueStatus("https://errors.example.com", "tok", "acme", "42", "resolved", fetchFn).catch(() => {});
    expect(calls.map((call) => call.init?.redirect)).toEqual(["error", "error"]);
  });

  it("count an answer that is not a list as an error, not as an empty inbox", async () => {
    const { fetchFn } = recordingFetch(() => responseWithLink(200, { detail: "x" }, null));
    await expect(listIssues("https://errors.example.com", "tok", "acme", {}, fetchFn)).rejects.toThrow(
      "GET /api/0/organizations/acme/issues/ -> not a list",
    );
  });
});

describe("issueUrl", () => {
  it("links the issue under its organization on the server's own address", () => {
    // The server's own permalink names the project slug, a page GlitchTip 6.2.0 does not serve.
    const fromServer = { id: "42", permalink: "https://errors.example.com/storefront/issues/42" };
    expect(issueUrl("https://errors.example.com/", "acme", fromServer)).toBe(
      "https://errors.example.com/acme/issues/42",
    );
    expect(issueUrl("https://errors.example.com", "a b", { id: "4/2" })).toBe(
      "https://errors.example.com/a%20b/issues/4%2F2",
    );
  });
});

describe("projectDsn", () => {
  it("reads the public DSN of the project's first key", async () => {
    const { fetchFn, calls } = recordingFetch(() =>
      jsonResponse(200, [{ dsn: { public: "https://k@errors.example.com/7", secret: "x" } }]),
    );
    expect(await projectDsn("https://errors.example.com/", "tok", "acme", "web app", fetchFn)).toBe(
      "https://k@errors.example.com/7",
    );
    expect(calls[0].url).toBe("https://errors.example.com/api/0/projects/acme/web%20app/keys/");
    expectGetOnly(calls);
  });

  it("throws when the project has no key or the read is refused", async () => {
    await expect(projectDsn("https://e.example", "tok", "acme", "web", recordingFetch(() => jsonResponse(200, [])).fetchFn)).rejects.toThrow(
      "no key",
    );
    await expect(projectDsn("https://e.example", "tok", "acme", "web", recordingFetch(() => jsonResponse(403, {})).fetchFn)).rejects.toThrow(
      "HTTP 403",
    );
  });
});
