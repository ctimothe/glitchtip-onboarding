#!/usr/bin/env node
// Sends the corpus (corpus.mjs) to the local GlitchTip as Sentry envelopes, the wire format the
// SDKs use. Creates the three projects when they are missing.
//
//   node test/live-glitchtip/seed.mjs                       every scenario, its full event count
//   node test/live-glitchtip/seed.mjs --only api-database-refused --events 40
//
// Talks to loopback only, with the development token GlitchTip creates for itself (compose.yaml).

import { randomUUID } from "node:crypto";

import { PROJECTS, SCENARIOS } from "./corpus.mjs";

export const BASE = process.env.LIVE_GLITCHTIP_URL ?? "http://127.0.0.1:8377";
export const TOKEN = "d".repeat(64);
export const ORG = "org";
const TEAM = "team";

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  throw new Error(`seed.mjs only talks to a GlitchTip on this machine, not ${BASE}`);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

/** slug -> { id, key }, creating any project the corpus needs. */
export async function ensureProjects() {
  const existing = await api(`/api/0/organizations/${ORG}/projects/`);
  const out = {};
  for (const { slug, platform } of PROJECTS) {
    if (!existing.some((p) => p.slug === slug)) {
      await api(`/api/0/teams/${ORG}/${TEAM}/projects/`, { method: "POST", body: JSON.stringify({ name: slug, platform }) });
    }
    const keys = await api(`/api/0/projects/${ORG}/${slug}/keys/`);
    const dsn = new URL(keys[0].dsn.public);
    out[slug] = { id: dsn.pathname.replace(/^\//, ""), key: dsn.username };
  }
  return out;
}

const SDK = {
  node: { name: "sentry.javascript.node", version: "10.73.0" },
  javascript: { name: "sentry.javascript.nextjs", version: "10.73.0" },
  python: { name: "sentry.python.celery", version: "2.64.0" },
};

/** One event of a scenario, as its SDK would send it; `n` picks which of its users hit it. */
export function buildEvent(scenario, n = 0) {
  const event = {
    event_id: randomUUID().replaceAll("-", ""),
    timestamp: new Date().toISOString(),
    platform: scenario.platform,
    level: scenario.level ?? "error",
    environment: scenario.environment,
    sdk: SDK[scenario.platform],
    tags: { event_kind: "error", project: scenario.project, ...scenario.tags },
  };
  if (scenario.release) event.release = scenario.release;
  if (scenario.serverName) event.server_name = scenario.serverName;
  if (scenario.transaction) event.transaction = scenario.transaction;
  if (scenario.logger) event.logger = scenario.logger;
  if (scenario.message) event.logentry = { formatted: scenario.message };
  if (scenario.type) {
    event.exception = {
      values: [
        {
          type: scenario.type,
          value: scenario.value,
          mechanism: scenario.mechanism,
          ...(scenario.frames.length > 0 ? { stacktrace: { frames: [...scenario.frames].reverse() } } : {}),
        },
      ],
    };
  }
  if (scenario.request) {
    event.request = {
      url: scenario.request.url,
      ...(scenario.request.method ? { method: scenario.request.method } : {}),
      headers: { "User-Agent": scenario.request.userAgent },
    };
  }
  if (scenario.users > 0) event.user = { id: `user-${scenario.id}-${n % scenario.users}` };
  return event;
}

export async function send(project, event) {
  const envelope = [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
  const res = await fetch(`${BASE}/api/${project.id}/envelope/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${project.key}, sentry_client=${event.sdk.name}/${event.sdk.version}`,
    },
    body: envelope,
  });
  if (!res.ok) throw new Error(`envelope for ${event.tags.project} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Send `events` events of each chosen scenario (default: the scenario's own count). */
export async function fire({ only = null, events = null } = {}) {
  const projects = await ensureProjects();
  const chosen = SCENARIOS.filter((s) => only === null || only.includes(s.id));
  if (only !== null && chosen.length !== only.length) {
    throw new Error(`unknown scenario in ${only.join(", ")}`);
  }
  let sent = 0;
  for (const scenario of chosen) {
    const count = events ?? scenario.events;
    for (let n = 0; n < count; n += 1) {
      await send(projects[scenario.project], buildEvent(scenario, n));
      sent += 1;
    }
  }
  return { scenarios: chosen.length, sent };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const only = value("--only")?.split(",") ?? null;
  const events = value("--events") ? Number(value("--events")) : null;
  const result = await fire({ only, events });
  console.log(`sent ${result.sent} events across ${result.scenarios} scenarios to ${BASE}`);
}
