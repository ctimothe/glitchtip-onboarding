// GlitchTip REST client for the desktop wizard.
//
// Endpoint shapes transcribed from `references/api.md` (verified against live
// GlitchTip 6.2.0) and the create + dry-run branches of
// `assets/glitchtip_onboard.py`.
// Read helpers (`checkInstance`, `fetchInventory`) take an injected `fetchFn`
// so tests run on mocked fetch and no call in this module's read path ever
// mutates server state (GET only — asserted in `glitchtip.test.ts` as a
// spec-grade dry-run-purity invariant). Writes live only in
// `provisionInventory`, which mirrors the script's create order
// (org -> team -> project -> key -> alert rule).

const NOT_GLITCHTIP = "not-a-glitchtip-instance";
const TIMEOUT_MS = 20_000;

export type InstanceInfo = {
  url: string;
  glitchtipTitle: boolean;
  latencyMs: number;
};

export type Inventory = {
  org: string | null;
  team: string | null;
  project: string | null;
  key: boolean;
  alertRule: boolean;
  /** Every team slug in the org (empty when the org is missing). */
  teams: string[];
  /** Every project slug in the org (empty when the org is missing). */
  projects: string[];
};

/** Explicit convergence target: lets the UI select among multiple
 * teams/projects instead of accepting the heuristic default. */
export type InventorySelection = {
  team?: string;
  project?: string;
};

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function getJson(
  url: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(url, { headers: authHeaders(token) });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// Where the API schema lives: self-hosted 6.2.0 serves it under /api/0/
// (references/api.md); app.glitchtip.com answers 404 there and serves it at
// /api/openapi.json (checked 2026-10-28). The first one that answers is used.
const SCHEMA_PATHS = ["/api/0/openapi.json", "/api/openapi.json"];

/** Phase 0 ground truth: confirm the base URL serves the GlitchTip API. */
export async function checkInstance(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<InstanceInfo> {
  const base = normalizeBase(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    let res: Response | null = null;
    for (const path of SCHEMA_PATHS) {
      res = await fetchFn(`${base}${path}`, { signal: controller.signal });
      if (res.ok) break;
    }
    if (!res?.ok) throw new Error(NOT_GLITCHTIP);
    let doc: unknown;
    try {
      doc = await res.json();
    } catch (err) {
      throw new Error(NOT_GLITCHTIP, { cause: err });
    }
    // Live GlitchTip nests the title under `info` per OpenAPI 3.1
    // (`references/api.md` reads `d["info"]`); a top-level `title` is also
    // accepted so older/alternate shapes still probe green.
    const record = doc as { info?: { title?: unknown }; title?: unknown } | null;
    const title = record?.info?.title ?? record?.title;
    if (title !== "GlitchTip API") throw new Error(NOT_GLITCHTIP);
    return { url: base, glitchtipTitle: true, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof Error && err.message === NOT_GLITCHTIP) throw err;
    throw new Error(NOT_GLITCHTIP, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

const EMPTY_INVENTORY: Inventory = {
  org: null,
  team: null,
  project: null,
  key: false,
  alertRule: false,
  teams: [],
  projects: [],
};

/**
 * Read-only inventory mirroring `glitchtip_onboard.py --dry-run` semantics:
 * org must exist (404 -> empty inventory; anything else non-2xx throws, so a
 * bad token never masquerades as "nothing provisioned"), then team / project /
 * keys / alert rules are reported as found-or-missing. Never creates anything.
 *
 * Heuristic default (confirmed against the multi-team UI need — see report):
 * with only the org known, the reported team prefers the org-named team (the
 * one provisioning converges on) and falls back to the first team; the
 * reported project is the org's first project, or null when there is none.
 * The full `teams` / `projects` lists are always returned so the UI can offer
 * a selector when the org holds more than one of either; passing
 * `selection.team` / `selection.project` converges the key/alert evidence onto
 * the chosen project instead of the heuristic default (an unknown-but-named
 * selection is reported verbatim with key/alertRule false, so a not-yet-made
 * project reads as missing rather than as an error).
 */
export async function fetchInventory(
  baseUrl: string,
  token: string,
  org: string,
  fetchFn: typeof fetch = fetch,
  selection: InventorySelection = {},
): Promise<Inventory> {
  const base = normalizeBase(baseUrl);
  const orgPath = encodeURIComponent(org);

  const orgRes = await getJson(`${base}/api/0/organizations/${orgPath}/`, token, fetchFn);
  if (orgRes.status === 404) return { ...EMPTY_INVENTORY };
  if (orgRes.status < 200 || orgRes.status >= 300) {
    throw new Error(`GET /api/0/organizations/${org}/ -> HTTP ${orgRes.status}`);
  }

  const teamsRes = await getJson(
    `${base}/api/0/organizations/${orgPath}/teams/`,
    token,
    fetchFn,
  );
  let teams: string[] = [];
  if (teamsRes.status >= 200 && teamsRes.status < 300 && Array.isArray(teamsRes.body)) {
    teams = (teamsRes.body as { slug?: unknown }[])
      .map((t) => t.slug)
      .filter((s): s is string => typeof s === "string");
  } else if (teamsRes.status !== 404) {
    throw new Error(
      `GET /api/0/organizations/${org}/teams/ -> HTTP ${teamsRes.status}`,
    );
  }
  const wantedTeam = selection.team?.trim() || "";
  const team =
    wantedTeam !== "" ? wantedTeam : (teams.find((s) => s === org) ?? teams[0] ?? null);

  const projectsRes = await getJson(
    `${base}/api/0/organizations/${orgPath}/projects/`,
    token,
    fetchFn,
  );
  let projects: string[] = [];
  if (
    projectsRes.status >= 200 &&
    projectsRes.status < 300 &&
    Array.isArray(projectsRes.body)
  ) {
    projects = (projectsRes.body as { slug?: unknown }[])
      .map((p) => p.slug)
      .filter((s): s is string => typeof s === "string");
  } else if (projectsRes.status !== 404) {
    throw new Error(
      `GET /api/0/organizations/${org}/projects/ -> HTTP ${projectsRes.status}`,
    );
  }
  const wantedProject = selection.project?.trim() || "";
  const project = wantedProject !== "" ? wantedProject : (projects[0] ?? null);

  let key = false;
  let alertRule = false;
  if (project !== null) {
    const projectPath = encodeURIComponent(project);
    const keysRes = await getJson(
      `${base}/api/0/projects/${orgPath}/${projectPath}/keys/`,
      token,
      fetchFn,
    );
    if (keysRes.status >= 200 && keysRes.status < 300 && Array.isArray(keysRes.body)) {
      key = keysRes.body.length > 0;
    } else if (keysRes.status !== 404) {
      throw new Error(
        `GET /api/0/projects/${org}/${project}/keys/ -> HTTP ${keysRes.status}`,
      );
    }
    const alertsRes = await getJson(
      `${base}/api/0/projects/${orgPath}/${projectPath}/alerts/`,
      token,
      fetchFn,
    );
    if (
      alertsRes.status >= 200 &&
      alertsRes.status < 300 &&
      Array.isArray(alertsRes.body)
    ) {
      alertRule = alertsRes.body.length > 0;
    } else if (alertsRes.status !== 404) {
      throw new Error(
        `GET /api/0/projects/${org}/${project}/alerts/ -> HTTP ${alertsRes.status}`,
      );
    }
  }

  return { org, team, project, key, alertRule, teams, projects };
}

// ---------------------------------------------------------------- provision
//
// Create branch mirroring `assets/glitchtip_onboard.py` (same dependency
// order, same endpoint paths — see `references/api.md`):
//   org (never created) -> team -> project -> key -> alert rule.
// Each step reports created / existed / failed (or skipped for the alert rule
// when no relay URL is given) with evidence, and the run stops at the first
// failure. Re-running a fully provisioned org returns all-existed, matching
// the script's "already configured" semantics.

/** Alert rule name converged on by the script and the desktop wizard alike. */
export const ALERT_RULE_NAME = "All new issues to Telegram";

export type ProvisionStepId = "org" | "team" | "project" | "key" | "alert";
/** "pending": an existing rule still sends elsewhere and was left as it is (`switchExisting: false`). */
export type ProvisionStepStatus = "created" | "existed" | "updated" | "pending" | "failed" | "skipped";

export type ProvisionStepResult = {
  step: ProvisionStepId;
  status: ProvisionStepStatus;
  evidence: string;
  /** Why a failed step failed, when the user can fix it outside this app. */
  reason?: "private-webhooks";
};

export type ProvisionRequest = {
  /** Team slug to converge on (defaults to the org slug downstream). */
  team: string;
  /** Project slug to converge on. */
  project: string;
  /** Human display name for a project being created (defaults to the slug). */
  projectName?: string;
  /** Platform string for a project being created (defaults to "other"). */
  platform?: string;
  /** Relay URL for the alert rule; empty means the alert step is skipped. */
  webhookUrl?: string;
  /** Alert rule name (defaults to ALERT_RULE_NAME). */
  alertName?: string;
  /** Point an existing rule that sends elsewhere at the relay (default); false leaves it "pending". */
  switchExisting?: boolean;
  /**
   * Alert thresholds converged at rule creation (gallery presets, v2 Task 5
   * — chatty 1/10, balanced 3/15, quiet 10/60). Defaults preserve the v1
   * rule (1 event within 10 minutes); non-positive values fall back too.
   */
  quantity?: number;
  timespanMinutes?: number;
};

function postJson(
  url: string,
  token: string,
  body: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  return sendJson("POST", url, token, body, fetchFn);
}

async function sendJson(
  method: "POST" | "PUT",
  url: string,
  token: string,
  body: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(url, {
    method,
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function slugsOf(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return (body as { slug?: unknown }[])
    .map((t) => t.slug)
    .filter((s): s is string => typeof s === "string");
}

function alertIdOf(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as { pk?: unknown; id?: unknown };
  if (typeof record.pk === "number" || typeof record.pk === "string") {
    return String(record.pk);
  }
  if (typeof record.id === "number" || typeof record.id === "string") {
    return String(record.id);
  }
  return null;
}

type AlertRecipient = { recipientType: string; url: string } & Record<string, unknown>;

// Recipient types GlitchTip takes back with a url and tags alone (apps/alerts schemas).
const URL_RECIPIENTS = new Set(["email", "webhook", "discord", "feishu", "googlechat", "teams", "ntfy"]);

/**
 * A listed rule's recipients as GlitchTip's update takes them back, every setting kept; null when
 * one cannot be: an unknown type, or a Zulip recipient whose settings were not returned.
 */
function recipientsOf(rule: unknown): AlertRecipient[] | null {
  const list = (rule as { alertRecipients?: unknown }).alertRecipients;
  if (!Array.isArray(list)) return [];
  const kept: AlertRecipient[] = [];
  for (const item of list as Record<string, unknown>[]) {
    const type = item?.recipientType;
    if (typeof type !== "string") return null;
    const recipient: AlertRecipient = { recipientType: type, url: typeof item.url === "string" ? item.url : "" };
    if (item.tagsToAdd !== undefined && item.tagsToAdd !== null) recipient.tagsToAdd = item.tagsToAdd;
    if (type === "zulip") {
      // Listed as `config` in the stored names; sent back as the input's own fields.
      const config = (item.config ?? {}) as Record<string, unknown>;
      const { bot_email: botEmail, api_key: apiKey, channel, topic } = config;
      if (typeof botEmail !== "string" || typeof apiKey !== "string" || typeof channel !== "string") return null;
      kept.push({ ...recipient, botEmail, apiKey, channel, ...(typeof topic === "string" ? { topic } : {}) });
    } else if (URL_RECIPIENTS.has(type)) {
      kept.push(recipient);
    } else {
      return null;
    }
  }
  return kept;
}

// GlitchTip 6.1.7 and later refuse a webhook to a private or internal address, which the relay's
// address on the Docker network is, unless GLITCHTIP_ALLOW_PRIVATE_IPS is on.
function refusesPrivateWebhooks(res: { status: number; body: unknown }): boolean {
  return res.status === 422 && /private or internal ip/i.test(JSON.stringify(res.body ?? ""));
}

/** Positive-int-or-fallback for optional alert thresholds (v2 Task 5). */
function asPositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : fallback;
}

export async function provisionInventory(
  baseUrl: string,
  token: string,
  org: string,
  req: ProvisionRequest,
  fetchFn: typeof fetch = fetch,
): Promise<ProvisionStepResult[]> {
  const base = normalizeBase(baseUrl);
  const team = req.team.trim();
  const project = req.project.trim();
  const orgPath = encodeURIComponent(org);
  const teamPath = encodeURIComponent(team);
  const projectPath = encodeURIComponent(project);
  const projectName = req.projectName?.trim() || project;
  const platform = req.platform?.trim() || "other";
  const webhookUrl = req.webhookUrl?.trim() || "";
  const alertName = req.alertName?.trim() || ALERT_RULE_NAME;
  const quantity = asPositiveInt(req.quantity, 1);
  const timespanMinutes = asPositiveInt(req.timespanMinutes, 10);

  const steps: ProvisionStepResult[] = [];
  let current: ProvisionStepId = "org";
  const fail = (evidence: string): ProvisionStepResult[] => {
    steps.push({ step: current, status: "failed", evidence });
    return steps;
  };
  const failPrivate = (request: string): ProvisionStepResult[] => {
    steps.push({
      step: current,
      status: "failed",
      reason: "private-webhooks",
      evidence: `${request} — GlitchTip refuses webhooks to a private address; set GLITCHTIP_ALLOW_PRIVATE_IPS=true on its web and worker containers.`,
    });
    return steps;
  };

  try {
    // 1. Org must exist — never created implicitly (billing/ownership
    //    boundary, same rule as the script).
    const orgRes = await getJson(`${base}/api/0/organizations/${orgPath}/`, token, fetchFn);
    if (orgRes.status === 404) {
      return fail(
        `GET /api/0/organizations/${org}/ -> 404 — the organization does not exist; create it in the GlitchTip UI first.`,
      );
    }
    if (orgRes.status < 200 || orgRes.status >= 300) {
      return fail(`GET /api/0/organizations/${org}/ -> HTTP ${orgRes.status}`);
    }
    steps.push({
      step: "org",
      status: "existed",
      evidence: `GET /api/0/organizations/${org}/ -> ${orgRes.status} — organization “${org}” exists.`,
    });

    // 2. Team — matched by slug, created when missing.
    current = "team";
    if (team === "") {
      return fail("no team slug given — enter a team name to converge on.");
    }
    const teamsRes = await getJson(
      `${base}/api/0/organizations/${orgPath}/teams/`,
      token,
      fetchFn,
    );
    if (teamsRes.status >= 200 && teamsRes.status < 300) {
      if (slugsOf(teamsRes.body).includes(team)) {
        steps.push({
          step: "team",
          status: "existed",
          evidence: `GET /api/0/organizations/${org}/teams/ -> team “${team}” already exists.`,
        });
      } else {
        const created = await postJson(
          `${base}/api/0/organizations/${orgPath}/teams/`,
          token,
          { slug: team },
          fetchFn,
        );
        if (created.status < 200 || created.status >= 300) {
          return fail(
            `POST /api/0/organizations/${org}/teams/ -> HTTP ${created.status} — could not create team “${team}”.`,
          );
        }
        steps.push({
          step: "team",
          status: "created",
          evidence: `POST /api/0/organizations/${org}/teams/ -> ${created.status} — team “${team}” created.`,
        });
      }
    } else if (teamsRes.status === 404) {
      const created = await postJson(
        `${base}/api/0/organizations/${orgPath}/teams/`,
        token,
        { slug: team },
        fetchFn,
      );
      if (created.status < 200 || created.status >= 300) {
        return fail(
          `POST /api/0/organizations/${org}/teams/ -> HTTP ${created.status} — could not create team “${team}”.`,
        );
      }
      steps.push({
        step: "team",
        status: "created",
        evidence: `POST /api/0/organizations/${org}/teams/ -> ${created.status} — team “${team}” created.`,
      });
    } else {
      return fail(
        `GET /api/0/organizations/${org}/teams/ -> HTTP ${teamsRes.status}`,
      );
    }

    // 3. Project — listed on the org endpoint, but creation lives on the
    //    TEAM endpoint (the org projects endpoint is GET-only).
    current = "project";
    if (project === "") {
      return fail("no project slug given — enter a project name to converge on.");
    }
    const projectsRes = await getJson(
      `${base}/api/0/organizations/${orgPath}/projects/`,
      token,
      fetchFn,
    );
    if (projectsRes.status >= 200 && projectsRes.status < 300) {
      if (slugsOf(projectsRes.body).includes(project)) {
        steps.push({
          step: "project",
          status: "existed",
          evidence: `GET /api/0/organizations/${org}/projects/ -> project “${project}” already exists.`,
        });
      } else {
        const created = await postJson(
          `${base}/api/0/teams/${orgPath}/${teamPath}/projects/`,
          token,
          { name: projectName, slug: project, platform },
          fetchFn,
        );
        if (created.status < 200 || created.status >= 300) {
          return fail(
            `POST /api/0/teams/${org}/${team}/projects/ -> HTTP ${created.status} — could not create project “${project}”.`,
          );
        }
        steps.push({
          step: "project",
          status: "created",
          evidence: `POST /api/0/teams/${org}/${team}/projects/ -> ${created.status} — project “${project}” created.`,
        });
      }
    } else if (projectsRes.status === 404) {
      const created = await postJson(
        `${base}/api/0/teams/${orgPath}/${teamPath}/projects/`,
        token,
        { name: projectName, slug: project, platform },
        fetchFn,
      );
      if (created.status < 200 || created.status >= 300) {
        return fail(
          `POST /api/0/teams/${org}/${team}/projects/ -> HTTP ${created.status} — could not create project “${project}”.`,
        );
      }
      steps.push({
        step: "project",
        status: "created",
        evidence: `POST /api/0/teams/${org}/${team}/projects/ -> ${created.status} — project “${project}” created.`,
      });
    } else {
      return fail(
        `GET /api/0/organizations/${org}/projects/ -> HTTP ${projectsRes.status}`,
      );
    }

    // 4. Key — read back, created only when the project genuinely has none.
    current = "key";
    const keysRes = await getJson(
      `${base}/api/0/projects/${orgPath}/${projectPath}/keys/`,
      token,
      fetchFn,
    );
    if (keysRes.status >= 200 && keysRes.status < 300 && Array.isArray(keysRes.body)) {
      if (keysRes.body.length > 0) {
        steps.push({
          step: "key",
          status: "existed",
          evidence: `GET /api/0/projects/${org}/${project}/keys/ -> ${keysRes.body.length} key(s) already present.`,
        });
      } else {
        const created = await postJson(
          `${base}/api/0/projects/${orgPath}/${projectPath}/keys/`,
          token,
          { name: "default" },
          fetchFn,
        );
        if (created.status < 200 || created.status >= 300) {
          return fail(
            `POST /api/0/projects/${org}/${project}/keys/ -> HTTP ${created.status} — could not create a project key.`,
          );
        }
        steps.push({
          step: "key",
          status: "created",
          evidence: `POST /api/0/projects/${org}/${project}/keys/ -> ${created.status} — key “default” created.`,
        });
      }
    } else if (keysRes.status === 404) {
      const created = await postJson(
        `${base}/api/0/projects/${orgPath}/${projectPath}/keys/`,
        token,
        { name: "default" },
        fetchFn,
      );
      if (created.status < 200 || created.status >= 300) {
        return fail(
          `POST /api/0/projects/${org}/${project}/keys/ -> HTTP ${created.status} — could not create a project key.`,
        );
      }
      steps.push({
        step: "key",
        status: "created",
        evidence: `POST /api/0/projects/${org}/${project}/keys/ -> ${created.status} — key “default” created.`,
      });
    } else {
      return fail(
        `GET /api/0/projects/${org}/${project}/keys/ -> HTTP ${keysRes.status}`,
      );
    }

    // 5. Alert rule — matched by name so a re-run never stacks duplicates.
    //    Without a relay URL there is nothing to point it at, so skip.
    current = "alert";
    if (webhookUrl === "") {
      steps.push({
        step: "alert",
        status: "skipped",
        evidence:
          "no relay URL given — skipping the alert rule; add one to notify Telegram.",
      });
      return steps;
    }
    const alertsPath = `/api/0/projects/${org}/${project}/alerts/`;
    const alertsUrl = `${base}/api/0/projects/${orgPath}/${projectPath}/alerts/`;
    const alertsRes = await getJson(alertsUrl, token, fetchFn);
    let match: unknown;
    if (alertsRes.status >= 200 && alertsRes.status < 300 && Array.isArray(alertsRes.body)) {
      match = (alertsRes.body as { name?: unknown }[]).find((a) => a.name === alertName);
    } else if (alertsRes.status !== 404) {
      return fail(`GET ${alertsPath} -> HTTP ${alertsRes.status}`);
    }
    if (match === undefined) {
      const created = await postJson(
        alertsUrl,
        token,
        {
          name: alertName,
          timespanMinutes,
          quantity,
          alertRecipients: [{ recipientType: "webhook", url: webhookUrl }],
        },
        fetchFn,
      );
      if (created.status < 200 || created.status >= 300) {
        return refusesPrivateWebhooks(created)
          ? failPrivate(`POST ${alertsPath} -> HTTP ${created.status}`)
          : fail(`POST ${alertsPath} -> HTTP ${created.status} — could not create rule “${alertName}”.`);
      }
      const id = alertIdOf(created.body);
      steps.push({
        step: "alert",
        status: "created",
        evidence:
          `POST ${alertsPath} -> ${created.status} — rule “${alertName}” created` +
          (id === null ? "." : ` (id ${id}).`),
      });
      return steps;
    }

    // A rule kept from an earlier relay (the v1 Mac relay, or a server since replaced) still sends
    // elsewhere. Its webhooks are this app's own, since the rule carries this app's name; its other
    // recipients are kept with every setting they have.
    const recipients = recipientsOf(match);
    if (recipients === null) {
      return fail(`GET ${alertsPath} -> rule “${alertName}” has a recipient this app cannot keep unchanged; edit the rule in GlitchTip.`);
    }
    const webhooks = recipients.filter((r) => r.recipientType === "webhook");
    if (webhooks.length === 1 && webhooks[0].url === webhookUrl) {
      steps.push({
        step: "alert",
        status: "existed",
        evidence: `GET ${alertsPath} -> rule “${alertName}” already sends to the relay.`,
      });
      return steps;
    }
    if (req.switchExisting === false) {
      steps.push({
        step: "alert",
        status: "pending",
        evidence: `GET ${alertsPath} -> rule “${alertName}” still sends elsewhere; it is switched once delivery is proven.`,
      });
      return steps;
    }
    const id = alertIdOf(match);
    if (id === null) return fail(`GET ${alertsPath} -> rule “${alertName}” has no id.`);
    // GlitchTip applies only the fields sent and replaces the recipient list.
    const updated = await sendJson(
      "PUT",
      `${alertsUrl}${encodeURIComponent(id)}/`,
      token,
      {
        alertRecipients: [
          ...recipients.filter((r) => r.recipientType !== "webhook"),
          { recipientType: "webhook", url: webhookUrl },
        ],
      },
      fetchFn,
    );
    if (updated.status < 200 || updated.status >= 300) {
      return refusesPrivateWebhooks(updated)
        ? failPrivate(`PUT ${alertsPath}${id}/ -> HTTP ${updated.status}`)
        : fail(`PUT ${alertsPath}${id}/ -> HTTP ${updated.status} — could not point rule “${alertName}” at the relay.`);
    }
    steps.push({
      step: "alert",
      status: "updated",
      evidence: `PUT ${alertsPath}${id}/ -> ${updated.status} — rule “${alertName}” now sends to the relay.`,
    });

    return steps;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ step: current, status: "failed", evidence: message });
    return steps;
  }
}
