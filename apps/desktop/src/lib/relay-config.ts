// The relay's environment file, built from the workspace and its Keychain
// tokens. `deploy_relay` (src-tauri/src/remote.rs) reads it from the Keychain
// item `relay.env` and installs it on the server as `shared/relay.env`, the
// Compose `env_file` that assets/relay/config.js `readConfig` parses.
//
// The relay is configured in three steps, each a redeploy: unpaired (tokens
// only) when it is first deployed, paired once Telegram pairing finishes, and
// with every application once its topic exists.
//
// Every value is single-quoted, which Compose reads literally: no `$`
// expansion and no ` #` comment stripping. A single-quoted value cannot hold
// a quote, so quotes inside JSON become `'`, and a value that would
// still be misread (a quote, a control character, a trailing backslash) is
// refused rather than written.

import type { WorkspaceState } from "../app/workspace";
import { deployRelay, type DeployRequest, type DeploymentResult, type ServerRequest } from "./remote";
import * as keychainSecrets from "./secrets";

export const RELAY_ENV_KEY = "relay.env";

export type RelayEnvInput = { workspace: WorkspaceState; botToken: string; glitchtipToken: string };

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const UNSAFE = /[\x00-\x1f\x7f'\p{Zl}\p{Zp}]/u;

function quoted(value: string): string {
  if (value === "" || UNSAFE.test(value) || value.endsWith("\\")) throw new Error("relay-env-invalid");
  return `'${value}'`;
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "\\u0027").replace(/\p{Zl}/gu, "\\u2028").replace(/\p{Zp}/gu, "\\u2029");
}

/** The relay environment for `workspace`, one `KEY='value'` line each. */
export function buildRelayEnv({ workspace, botToken, glitchtipToken }: RelayEnvInput): string {
  const env: Array<[string, string]> = [
    ["COMPANION_WORKSPACE_ID", workspace.id],
    ["COMPANION_LOCALE", workspace.locale],
    ["TELEGRAM_BOT_TOKEN", botToken],
    ["GLITCHTIP_API_BASE", workspace.glitchtip.baseUrl.trim().replace(/\/+$/, "")],
    ["GLITCHTIP_API_TOKEN", glitchtipToken],
  ];
  const telegram = workspace.telegram;
  if (telegram) {
    // The relay refuses two applications with one project name, so a shared
    // name is left out and those applications route by project slug only.
    // The relay refuses an application without environments or with one twice.
    for (const app of workspace.applications) {
      if (app.environments.length === 0 || new Set(app.environments).size !== app.environments.length) {
        throw new Error("relay-env-invalid");
      }
    }
    const names = new Map<string, number>();
    for (const app of workspace.applications) names.set(app.name, (names.get(app.name) ?? 0) + 1);
    const applications = workspace.applications.map((app) => ({
      id: app.id,
      name: app.name,
      projectSlug: app.projectSlug,
      ...(names.get(app.name) === 1 ? { projectName: app.name } : {}),
      topicId: app.topicId,
      environments: app.environments,
    }));
    env.push(
      ["TELEGRAM_CHAT_ID", String(telegram.chatId)],
      ["ALLOWED_MEMBER_IDS", json(telegram.allowedMemberIds)],
      ["APPLICATIONS_JSON", json(applications)],
    );
  }
  return env.map(([key, value]) => `${key}=${quoted(value)}\n`).join("");
}

export type SecretStore = {
  get(workspaceId: string, key: string): Promise<string | null>;
  set(workspaceId: string, key: string, value: string): Promise<void>;
  remove(workspaceId: string, key: string): Promise<void>;
};

async function currentRelayEnv(workspace: WorkspaceState, secrets: SecretStore): Promise<string> {
  const [glitchtipToken, botToken] = await Promise.all([
    secrets.get(workspace.id, "glitchtip-token"),
    secrets.get(workspace.id, "telegram-bot-token"),
  ]);
  if (!glitchtipToken || !botToken) throw new Error("relay-secret-missing");
  return buildRelayEnv({ workspace, botToken, glitchtipToken });
}

/** Build the relay environment from the Keychain tokens and store it where `deploy_relay` reads it. */
export async function writeRelayEnv(workspace: WorkspaceState, secrets: SecretStore = keychainSecrets): Promise<void> {
  await secrets.set(workspace.id, RELAY_ENV_KEY, await currentRelayEnv(workspace, secrets));
}

/**
 * Whether the relay runs with the environment `workspace` and its tokens call for. The stored
 * `relay.env` is what the server runs, because a failed deploy puts it back (deployWorkspaceRelay),
 * as the server's installer does. "unknown" when nothing is stored or the tokens are missing.
 */
export async function relayEnvState(
  workspace: WorkspaceState,
  secrets: SecretStore = keychainSecrets,
): Promise<"current" | "outdated" | "unknown"> {
  const stored = await secrets.get(workspace.id, RELAY_ENV_KEY);
  if (stored === null) return "unknown";
  try {
    return stored === (await currentRelayEnv(workspace, secrets)) ? "current" : "outdated";
  } catch {
    return "unknown";
  }
}

/** Configure the relay for `workspace` and deploy it: the environment first, then the release. */
export async function deployWorkspaceRelay(
  workspace: WorkspaceState,
  server: ServerRequest,
  deps: { secrets?: SecretStore; deploy?: (request: DeployRequest) => Promise<DeploymentResult> } = {},
): Promise<DeploymentResult> {
  const secrets = deps.secrets ?? keychainSecrets;
  const previous = await secrets.get(workspace.id, RELAY_ENV_KEY);
  await writeRelayEnv(workspace, secrets);
  // A failed install restores the server's previous environment (or, on a first install,
  // removes it), so the stored one goes back too and keeps matching what the server runs.
  // A deploy that throws may have finished on the server before the connection dropped; the
  // previous one goes back then too, so the Relay server screen calls the settings outdated and
  // offers the Update that settles it, whichever release runs. Keeping the new one instead could
  // call settings current that the server rolled back.
  const restore = () =>
    previous === null ? secrets.remove(workspace.id, RELAY_ENV_KEY) : secrets.set(workspace.id, RELAY_ENV_KEY, previous);
  let result: DeploymentResult;
  try {
    result = await (deps.deploy ?? deployRelay)({
      ...server,
      workspaceId: workspace.id,
      applicationIds: workspace.applications.map((app) => app.id),
    });
  } catch (err) {
    await restore();
    throw err;
  }
  if (!result.ok) await restore();
  return result;
}
