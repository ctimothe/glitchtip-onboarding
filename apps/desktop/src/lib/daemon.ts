// Frontend API for the v1 local relay daemon — thin invoke wrappers used by
// the migration flow and the tray. All launchd/plist/log work happens in Rust
// commands (src-tauri/src/main.rs); the only logic here is assembling the
// install env record (the full plist XML is built by Rust `build_plist`).
//
// Secret flow (amended plan): the relay is env-only
// (assets/relay/server.js:12-18 — PORT, TELEGRAM_ALERT_BOT_TOKEN,
// TELEGRAM_ALERT_CHAT_ID, GLITCHTIP_API_BASE, GLITCHTIP_API_TOKEN,
// LOG_PAYLOAD, DEFAULT_PROJECT, PROJECT_APP_BASES, PROJECT_LOOKUP_TOKENS,
// OBSERVABILITY_LOOKUP_TOKEN, legacy APP_BASE_*). Tokens reach the daemon
// by copying current vault values into the plist EnvironmentVariables at
// enable/apply time (same UNIX user; the plist is written 0600). Tokens
// never appear in argv. Rotating a vault value requires re-apply.

import { invoke } from "@tauri-apps/api/core";

import { get as getSecret, LEGACY_WORKSPACE_ID } from "./secrets";

export type DaemonStatus = "running" | "stopped" | "not-installed";

export type DaemonStatusDetail = { state: DaemonStatus; pid: number | null };

export type DaemonPaths = {
  nodePath: string;
  relayEntryPath: string;
  plistPath: string;
  logPath: string;
};

// Must match REDACTED in src-tauri/src/main.rs. Displayed as-is for secret
// rows; sent back untouched for secrets the user did not change (the Rust
// side keeps the stored value in that case).
export const REDACTED_ENV_VALUE = "••••••••";

// Wizard vault keys (verified against src/screens/*Screen.tsx) and the
// relay env names they feed. Keys with no vault value are omitted so relay
// defaults apply (e.g. DEFAULT_PROJECT falls back to 'kelajakmerosi' in
// server.js when unset).
const VAULT_TO_ENV: Array<[vaultKey: string, envName: string]> = [
  ["telegram.botToken", "TELEGRAM_ALERT_BOT_TOKEN"],
  ["telegram.chatId", "TELEGRAM_ALERT_CHAT_ID"],
  ["glitchtip.url", "GLITCHTIP_API_BASE"],
  ["glitchtip.token", "GLITCHTIP_API_TOKEN"],
  ["glitchtip.project", "DEFAULT_PROJECT"],
];

export async function getDaemonStatusDetail(): Promise<DaemonStatusDetail> {
  const detail = await invoke<{ state: string; pid: number | null }>("daemon_status_detail");
  if (
    detail.state !== "running" &&
    detail.state !== "stopped" &&
    detail.state !== "not-installed"
  ) {
    throw new Error(`The relay reported an unknown status (“${detail.state}”).`);
  }
  return { state: detail.state, pid: detail.pid };
}

export async function getDaemonPaths(): Promise<DaemonPaths> {
  const [nodePath, relayEntryPath, plistPath, logPath] =
    await invoke<[string, string, string, string]>("daemon_paths");
  return { nodePath, relayEntryPath, plistPath, logPath };
}

// Wizard-managed values, re-synced from the vault on every enable.
async function collectRelayEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [vaultKey, envName] of VAULT_TO_ENV) {
    const value = await getSecret(LEGACY_WORKSPACE_ID, vaultKey);
    if (value !== null && value !== "") {
      env[envName] = value;
    }
  }
  return env;
}

export async function setDaemonEnabled(
  on: boolean,
  patch: Record<string, string> = {},
): Promise<string> {
  if (!on) {
    return invoke<string>("daemon_set_enabled", {
      enabled: false,
      env: null,
      runAtLoad: null,
    });
  }
  // Enable-time env assembly: vault re-sync first, explicit patch last.
  // Existing plist entries (user non-vault keys incl. raw lookup tokens,
  // PROJECT_APP_BASES edits, custom PORT) are preserved verbatim by the
  // Rust side from the file itself — this path NEVER reads displayed
  // (redacted) values, so reinstall cannot clobber them. PORT defaulting
  // also lives in Rust (only it knows the preserved PORT). The full plist
  // XML is constructed in Rust (`build_plist`); only the env record +
  // RunAtLoad flag cross IPC — finished XML is never sent.
  const env: Record<string, string> = await collectRelayEnv();
  for (const [key, value] of Object.entries(patch)) {
    // Same patch semantics as setRelayEnv: redacted keeps the stored
    // secret, "" marks the key for deletion (Rust drops it).
    if (value === REDACTED_ENV_VALUE) {
      continue;
    }
    env[key] = value;
  }
  return invoke<string>("daemon_set_enabled", {
    enabled: true,
    env,
    runAtLoad: false,
  });
}

/// Seed for the boot checkbox: true only when the installed plist carries
/// RunAtLoad (absent plist → false, never an error here — the toggle
/// surfaces a malformed plist when used).
export async function getBootOnLogin(): Promise<boolean> {
  return invoke<boolean>("daemon_get_boot");
}

export async function setBootOnLogin(on: boolean): Promise<string> {
  return invoke<string>("daemon_set_boot", { boot: on });
}

// Names plus display values (secrets come back as REDACTED_ENV_VALUE).
export async function getRelayEnv(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("relay_env_load");
}

// Merge a patch into the plist env: values overwrite/add, "" deletes the
// key, REDACTED_ENV_VALUE keeps the stored secret. Takes effect on relay
// restart (Disable then Enable) — the returned message says so.
export async function setRelayEnv(patch: Record<string, string>): Promise<string> {
  return invoke<string>("relay_env_save", { patch });
}
