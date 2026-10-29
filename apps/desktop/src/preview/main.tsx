// Browser preview of the whole app with the Tauri IPC mocked, for checking
// layout, light and dark appearance and keyboard flow without building the
// native shell. Never bundled: only preview.html loads it, and `vite build`
// builds index.html alone.
//
//   npm run dev:frontend  →  http://localhost:1420/preview.html?scenario=ready
//
// Scenarios: `ready` (finished setup with two applications; add `&relay=outdated` for a relay
// still on settings from before a change; `&v1=web` or `&v1=unknown` for a v1 relay still on this
// Mac after the move, with or without its project), `setup` (first run, setup assistant), `server`
// (setup resumed at the server step), `migration` (a Mac with a v1 install). Add `&locale=ru` or
// `&locale=uz` to switch language.

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import React from "react";
import { createRoot } from "react-dom/client";

import App from "../App";
import type { WorkspaceState } from "../app/workspace";
import { buildRelayEnv } from "../lib/relay-config";
import "../styles.css";

window.__COMPANION_PREVIEW__ = true;
mockWindows("main");

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "ready";
const locale = (params.get("locale") ?? "en") as WorkspaceState["locale"];
const v1 = scenario === "ready" ? params.get("v1") : null;
let macRelay = scenario === "migration" || v1 !== null ? "running" : "not-installed";
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const workspace: WorkspaceState = {
  schemaVersion: 1,
  id: "default",
  name: "Main",
  locale,
  glitchtip: { baseUrl: "https://glitchtip.example.com", organizationSlug: "acme", verifiedAt: ago(60 * 24) },
  relay: {
    host: "relay.example.com",
    user: "deploy",
    port: 22,
    identityFile: "",
    dockerNetwork: "glitchtip_default",
    deploymentDir: "$HOME/.local/share/glitchtip-companion",
    revision: "3f9c2a1",
    previousRevision: "b71e0d4",
    status: "healthy",
    verifiedAt: ago(12),
  },
  telegram: {
    botId: 7000000001,
    botUsername: "acme_alerts_bot",
    chatId: -1001000000001,
    chatTitle: "Acme incidents",
    allowedMemberIds: [1001, 1002, 1003],
    pairedAt: ago(60 * 24 * 3),
  },
  applications: [
    {
      id: "web",
      name: "Acme web",
      projectSlug: "acme-web",
      environments: ["production", "staging"],
      topicId: 12,
      topicColor: 0x6fb9f0,
      alertPreset: "balanced",
      enabledStates: ["error", "warning", "resolved", "setup_complete", "test"],
      repositoryPath: "~/code/acme-web",
      agent: { providers: ["codex", "claude"], skillVersion: "1.4.0", helperVersion: "1.4.0", verifiedAt: ago(60 * 5) },
      verifiedAt: ago(60 * 5),
    },
    {
      id: "api",
      name: "Acme API",
      projectSlug: "acme-api",
      environments: ["production"],
      topicId: 14,
      topicColor: 0xcb86db,
      alertPreset: "quiet",
      enabledStates: ["error", "resolved"],
      repositoryPath: null,
      agent: null,
      verifiedAt: null,
    },
  ],
  onboarding: { completedAt: ago(60 * 24 * 3), currentStage: 6 },
};

const stored: Record<string, WorkspaceState> = {
  ready: workspace,
  server: { ...workspace, relay: null, telegram: null, applications: [], onboarding: { completedAt: null, currentStage: 2 } },
};

// Made-up tokens, so the Relay server screen can compare what the relay runs with the workspace.
const tokens = { botToken: "7000000001:preview-token", glitchtipToken: "preview-token" };
const deployed = params.get("relay") === "outdated" ? { ...workspace, locale: locale === "en" ? "ru" : "en" } : workspace;
const keychain: Record<string, Record<string, string>> = {
  ready: {
    "glitchtip-token": tokens.glitchtipToken,
    "telegram-bot-token": tokens.botToken,
    "relay.env": buildRelayEnv({ workspace: deployed as WorkspaceState, ...tokens }),
    ...(v1 !== null && v1 !== "unknown" ? { "glitchtip.project": v1 } : {}),
  },
  // The v1 vault as bootstrap copied it into the Keychain.
  migration: {
    "glitchtip.url": "https://glitchtip.example.com",
    "glitchtip.org": "acme",
    "glitchtip.project": "web",
    "glitchtip.token": tokens.glitchtipToken,
    "telegram.botToken": tokens.botToken,
  },
};

// As the relay writes them (assets/relay/server.js writeAudit), oldest first.
const audit: Array<Record<string, unknown>> = [
  { eventId: "e1:error", applicationId: "api", state: "error", status: "delivered", at: ago(60 * 7), retryCount: 0 },
  { eventId: "e2:error", applicationId: "web", state: "error", status: "retrying", at: ago(97), retryCount: 1, failureCode: "telegram-429", nextRetryAt: ago(96) },
  { eventId: "e2:error", applicationId: "web", state: "error", status: "delivered", at: ago(95), retryCount: 1 },
  { eventId: "e2:error", applicationId: "web", state: "error", status: "prompt-sent", at: ago(60), retryCount: 0 },
  { eventId: "e3:warning", applicationId: "web", state: "warning", status: "retrying", at: ago(38), retryCount: 2, failureCode: "telegram-403", nextRetryAt: ago(33) },
  { eventId: "e4:resolved", applicationId: "api", state: "resolved", status: "delivered", at: ago(4), retryCount: 0 },
];

// Plugin-store files by resource id; only the workspace is pre-filled.
const files: Record<string, Map<string, unknown>> = {};
const rids: string[] = [];

mockIPC((cmd, payload) => {
  const args = (payload ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "plugin:store|load": {
      const path = String(args.path);
      files[path] ??= new Map<string, unknown>(
        path === "workspace.json" && stored[scenario]
          ? [["workspace", stored[scenario]]]
          : path === "settings.json" && v1 !== null
            ? [["migration.phase", "imported"]]
            : [],
      );
      rids.push(path);
      return rids.length - 1;
    }
    case "plugin:store|get": {
      const file = files[rids[Number(args.rid)]];
      const key = String(args.key);
      return [file?.get(key) ?? null, file?.has(key) ?? false];
    }
    case "plugin:store|set":
      files[rids[Number(args.rid)]]?.set(String(args.key), args.value);
      return null;
    case "secret_presence":
      return Object.keys(keychain[scenario] ?? {});
    case "secret_get":
      return keychain[scenario]?.[String(args.key)] ?? null;
    case "secret_set":
      (keychain[scenario] ??= {})[String(args.key)] = String(args.value);
      return null;
    case "secret_remove":
      delete keychain[scenario]?.[String(args.key)];
      return null;
    case "relay_log_tail":
      return "";
    case "daemon_status_detail":
      return { state: macRelay, pid: null };
    case "daemon_set_enabled":
      macRelay = "not-installed";
      return "";
    case "secret_remove_file_vault":
      return { removed: true };
    case "secret_migrate_file_vault":
      return { migrated: [], skipped: [] };
    case "relay_status":
      return { reachable: true, healthy: true, revision: workspace.relay?.revision ?? null, detail: "ok" };
    case "relay_audit_tail":
      return audit;
    case "deployment_preview":
      return {
        revision: "4a1d9e7",
        previousRevision: "3f9c2a1",
        files: [
          { path: "compose.yml", mode: "0644" },
          { path: "relay.env", mode: "0600" },
          { path: "relay/index.js", mode: "0644" },
        ],
        composeServices: ["relay"],
        publishedPorts: [],
        commands: ["docker compose pull", "docker compose up -d --remove-orphans", "docker compose ps"],
      };
    case "relay_control": {
      const command = args.command as { kind: string; applicationId?: string };
      if (command.kind !== "send-test") return { ok: true };
      // The relay queues the test and Telegram takes it at once.
      const eventId = `test-${audit.length}:test`;
      const applicationId = command.applicationId ?? "";
      audit.push({ eventId, applicationId, state: "test", status: "delivered", at: new Date().toISOString(), retryCount: 0 });
      return { eventId };
    }
    default:
      return null;
  }
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element missing");
createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
