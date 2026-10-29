import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import type { ApplicationState, WorkspaceState } from "../app/workspace";
import { RELAY_ENV_KEY, buildRelayEnv, deployWorkspaceRelay, relayEnvState, writeRelayEnv } from "./relay-config";
import type { DeployRequest, ServerRequest } from "./remote";

// The relay's own parser: the generated file must be one it accepts.
const { readConfig } = createRequire(import.meta.url)("../../../../assets/relay/config.js") as {
  readConfig: (env: Record<string, string>) => Record<string, unknown>;
};

const BOT = "123456:AA-bb_CC";
const API = "a1b2c3d4e5f6";

function application(patch: Partial<ApplicationState> = {}): ApplicationState {
  return {
    id: "billing",
    name: "Billing",
    projectSlug: "billing",
    environments: ["production"],
    topicId: 7,
    topicColor: 7322096,
    alertPreset: "balanced",
    enabledStates: ["error", "warning", "resolved", "setup_complete", "test"],
    repositoryPath: null,
    agent: null,
    verifiedAt: null,
    ...patch,
  };
}

function workspace(patch: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    schemaVersion: 1,
    id: "ws-1",
    name: "Test",
    locale: "ru",
    glitchtip: { baseUrl: "https://gt.example.com/", organizationSlug: "acme", verifiedAt: "2026-10-28T10:00:00.000Z" },
    relay: null,
    telegram: null,
    applications: [],
    onboarding: { completedAt: null, currentStage: 2 },
    ...patch,
  };
}

const paired = {
  botId: 123456,
  botUsername: "acme_bot",
  chatId: -1001234567890,
  chatTitle: "Ops",
  allowedMemberIds: [42],
  pairedAt: "2026-10-28T10:00:00.000Z",
};

// Docker Compose reads `KEY='value'` literally: no `$` expansion, no ` #` comments, no escapes
// (checked against Docker Compose 2 with Docker 29.5.2 on 2026-10-29).
function parse(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n").filter(Boolean)) {
    const match = /^([A-Z_]+)='([^']*)'$/.exec(line);
    if (!match) throw new Error(`unparsable line: ${line}`);
    env[match[1]] = match[2];
  }
  return env;
}

describe("relay environment", () => {
  it("configures an unpaired relay before Telegram is paired", () => {
    const env = parse(buildRelayEnv({ workspace: workspace(), botToken: BOT, glitchtipToken: API }));
    expect(env).toEqual({
      COMPANION_WORKSPACE_ID: "ws-1",
      COMPANION_LOCALE: "ru",
      TELEGRAM_BOT_TOKEN: BOT,
      GLITCHTIP_API_BASE: "https://gt.example.com",
      GLITCHTIP_API_TOKEN: API,
    });
    expect(readConfig(env)).toMatchObject({ paired: false, applications: [], glitchtipApiBase: "https://gt.example.com" });
  });

  it("adds the paired chat, its members and every application once paired", () => {
    const ws = workspace({
      telegram: paired,
      applications: [application(), application({ id: "web", name: "Web", projectSlug: "web", topicId: 9, environments: ["production", "staging"] })],
    });
    const config = readConfig(parse(buildRelayEnv({ workspace: ws, botToken: BOT, glitchtipToken: API })));
    expect(config).toMatchObject({ paired: true, chatId: -1001234567890, allowedMemberIds: [42] });
    expect(config.applications).toEqual([
      { id: "billing", name: "Billing", projectSlug: "billing", projectName: "Billing", topicId: 7, environments: ["production"] },
      { id: "web", name: "Web", projectSlug: "web", projectName: "Web", topicId: 9, environments: ["production", "staging"] },
    ]);
  });

  it("configures a paired relay with no applications while the first topic is created", () => {
    const config = readConfig(parse(buildRelayEnv({ workspace: workspace({ telegram: paired }), botToken: BOT, glitchtipToken: API })));
    expect(config).toMatchObject({ paired: true, applications: [] });
  });

  it("leaves out a project name two applications share, which the relay would refuse", () => {
    const ws = workspace({
      telegram: paired,
      applications: [application(), application({ id: "billing-eu", projectSlug: "billing-eu", topicId: 8 })],
    });
    const config = readConfig(parse(buildRelayEnv({ workspace: ws, botToken: BOT, glitchtipToken: API })));
    expect((config.applications as Array<Record<string, unknown>>).map((a) => Object.hasOwn(a, "projectName"))).toEqual([false, false]);
  });

  it("keeps names with quotes, hashes and dollar signs intact", () => {
    const name = `Billing #2 $HOME \\ "q" 'x`;
    const ws = workspace({ telegram: paired, applications: [application({ name })] });
    const text = buildRelayEnv({ workspace: ws, botToken: BOT, glitchtipToken: API });
    const config = readConfig(parse(text));
    expect((config.applications as Array<{ name: string }>)[0].name).toBe(name);
  });

  it.each([
    ["no environments", []],
    ["a repeated environment", ["production", "production"]],
  ])("refuses an application with %s, which the relay would not start with", (_, environments) => {
    const ws = workspace({ telegram: paired, applications: [application({ environments })] });
    expect(() => buildRelayEnv({ workspace: ws, botToken: BOT, glitchtipToken: API })).toThrow("relay-env-invalid");
  });

  it.each([
    ["a bot token with a quote", { botToken: "123:a'b" }],
    ["a bot token with a newline", { botToken: "123:ab\nGLITCHTIP_API_BASE=x" }],
    ["an API token ending in a backslash", { glitchtipToken: "abc\\" }],
    ["an empty bot token", { botToken: "" }],
  ])("refuses %s", (_, patch) => {
    expect(() => buildRelayEnv({ workspace: workspace(), botToken: BOT, glitchtipToken: API, ...patch })).toThrow("relay-env-invalid");
  });
});

function store(values: Record<string, string>) {
  const writes: Array<[string, string, string]> = [];
  return {
    writes,
    get: async (workspaceId: string, key: string) => (workspaceId === "ws-1" ? values[key] ?? null : null),
    set: async (workspaceId: string, key: string, value: string) => void writes.push([workspaceId, key, value]),
    remove: async () => undefined,
  };
}

describe("relay environment storage", () => {
  it("builds the file from the Keychain tokens and stores it for the deploy", async () => {
    const secrets = store({ "glitchtip-token": API, "telegram-bot-token": BOT });
    await writeRelayEnv(workspace(), secrets);
    expect(secrets.writes).toHaveLength(1);
    const [workspaceId, key, value] = secrets.writes[0];
    expect([workspaceId, key]).toEqual(["ws-1", RELAY_ENV_KEY]);
    expect(parse(value).TELEGRAM_BOT_TOKEN).toBe(BOT);
  });

  it("refuses when a token is missing from the Keychain", async () => {
    const secrets = store({ "glitchtip-token": API });
    await expect(writeRelayEnv(workspace(), secrets)).rejects.toThrow("relay-secret-missing");
    expect(secrets.writes).toEqual([]);
  });

  it("stores the file before it deploys, with every application id", async () => {
    const secrets = store({ "glitchtip-token": API, "telegram-bot-token": BOT });
    const order: string[] = [];
    const deployed: DeployRequest[] = [];
    const server: ServerRequest = {
      host: "relay.example.com",
      user: "deploy",
      port: 22,
      identityFile: "",
      dockerNetwork: "glitchtip_default",
      deploymentDir: "$HOME/.local/share/glitchtip-companion",
    };
    const ws = workspace({ telegram: paired, applications: [application()] });
    const result = await deployWorkspaceRelay(ws, server, {
      secrets: { ...secrets, set: async (...args) => (order.push("env"), secrets.set(...args)) },
      deploy: async (request) => {
        order.push("deploy");
        deployed.push(request);
        return { ok: true, revision: "r2", previousRevision: "r1", failedStep: null };
      },
    });
    expect(order).toEqual(["env", "deploy"]);
    expect(deployed).toEqual([{ ...server, workspaceId: "ws-1", applicationIds: ["billing"] }]);
    expect(result.revision).toBe("r2");
  });
});

// A Keychain that keeps what is written and removed.
function keychain(values: Record<string, string>) {
  const items = new Map(Object.entries(values));
  return {
    items,
    get: async (_: string, key: string) => items.get(key) ?? null,
    set: async (_: string, key: string, value: string) => void items.set(key, value),
    remove: async (_: string, key: string) => void items.delete(key),
  };
}

const SERVER: ServerRequest = {
  host: "relay.example.com",
  user: "deploy",
  port: 22,
  identityFile: "",
  dockerNetwork: "glitchtip_default",
  deploymentDir: "$HOME/.local/share/glitchtip-companion",
};

describe("relay environment after a deploy", () => {
  const failed = async () => ({ ok: false, revision: "r2", previousRevision: "r1", failedStep: "readiness" });

  it("puts back the environment the server still runs when the deploy fails", async () => {
    const secrets = keychain({ "glitchtip-token": API, "telegram-bot-token": BOT, [RELAY_ENV_KEY]: "OLD='1'\n" });
    const result = await deployWorkspaceRelay(workspace({ locale: "ru" }), SERVER, { secrets, deploy: failed });
    expect(result.ok).toBe(false);
    expect(secrets.items.get(RELAY_ENV_KEY)).toBe("OLD='1'\n");
  });

  it("puts it back when the deploy cannot run at all", async () => {
    const secrets = keychain({ "glitchtip-token": API, "telegram-bot-token": BOT, [RELAY_ENV_KEY]: "OLD='1'\n" });
    const deploy = async (): Promise<never> => {
      throw new Error("ssh-failed");
    };
    await expect(deployWorkspaceRelay(workspace(), SERVER, { secrets, deploy })).rejects.toThrow("ssh-failed");
    expect(secrets.items.get(RELAY_ENV_KEY)).toBe("OLD='1'\n");
  });

  it("asks for an Update after a deploy whose outcome is unknown, whichever release the server runs", async () => {
    const secrets = keychain({ "glitchtip-token": API, "telegram-bot-token": BOT });
    const before = workspace();
    await writeRelayEnv(before, secrets);
    const after = workspace({ locale: before.locale === "en" ? "ru" : "en" });
    const dropped = async (): Promise<never> => {
      throw new Error("ssh-connection-closed");
    };
    await expect(deployWorkspaceRelay(after, SERVER, { secrets, deploy: dropped })).rejects.toThrow();
    expect(await relayEnvState(after, secrets)).toBe("outdated");
  });

  it("removes it when a first deploy fails, as the server does", async () => {
    const secrets = keychain({ "glitchtip-token": API, "telegram-bot-token": BOT });
    await deployWorkspaceRelay(workspace(), SERVER, { secrets, deploy: failed });
    expect(secrets.items.has(RELAY_ENV_KEY)).toBe(false);
  });

  it("says the relay is out of date once the workspace or a token no longer matches what it runs", async () => {
    const secrets = keychain({ "glitchtip-token": API, "telegram-bot-token": BOT });
    const ws = workspace();
    expect(await relayEnvState(ws, secrets)).toBe("unknown");
    await writeRelayEnv(ws, secrets);
    expect(await relayEnvState(ws, secrets)).toBe("current");
    expect(await relayEnvState({ ...ws, locale: ws.locale === "en" ? "ru" : "en" }, secrets)).toBe("outdated");
    secrets.items.set("telegram-bot-token", "123456:rotated");
    expect(await relayEnvState(ws, secrets)).toBe("outdated");
  });
});
