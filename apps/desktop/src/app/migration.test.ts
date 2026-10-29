import { describe, expect, it } from "vitest";

import type { DaemonStatus } from "../lib/daemon";
import { createMigration, LEGACY_KEYS, type MigrationDeps, type MigrationPhase } from "./migration";

const V1 = {
  "glitchtip.url": "https://gt.example.com",
  "glitchtip.org": "acme",
  "glitchtip.project": "web",
  "glitchtip.token": "gt-secret",
  "telegram.botToken": "123:bot-secret",
  "telegram.chatId": "-1001234",
};

function harness(
  keychain: Record<string, string>,
  opts: { macRelay?: DaemonStatus; phase?: MigrationPhase | null; failVault?: boolean } = {},
) {
  const items = new Map(Object.entries(keychain));
  const ops: string[] = [];
  let macRelay = opts.macRelay ?? "running";
  let phase = opts.phase ?? null;
  const deps: MigrationDeps = {
    presence: async () => [...items.keys()],
    get: async (key) => items.get(key) ?? null,
    set: async (key, value) => void (ops.push(`set ${key}`), items.set(key, value)),
    remove: async (key) => void (ops.push(`remove ${key}`), items.delete(key)),
    macRelay: async () => macRelay,
    stopMacRelay: async () => void (ops.push("stop-mac-relay"), (macRelay = "not-installed")),
    removeFileVault: async () => {
      ops.push("remove-vault");
      if (opts.failVault) throw new Error("vault-not-verified");
    },
    loadPhase: async () => phase,
    savePhase: async (next) => void (ops.push(`phase ${next}`), (phase = next)),
  };
  return { migration: createMigration(deps), items, ops, phase: () => phase };
}

describe("migration from v1", () => {
  it("finds nothing to move on a Mac without v1", async () => {
    const { migration } = harness({ "glitchtip-token": "new" }, { macRelay: "not-installed" });
    expect(await migration.inspect()).toEqual({ kind: "fresh" });
  });

  it("shows what carries over, with secret presence only", async () => {
    const { migration } = harness(V1);
    const preview = await migration.inspect();
    expect(preview).toEqual({
      kind: "legacy",
      legacy: {
        glitchtipUrl: "https://gt.example.com",
        organizationSlug: "acme",
        projectSlug: "web",
        hasGlitchtipToken: true,
        hasBotToken: true,
        macRelay: "running",
      },
    });
    expect(JSON.stringify(preview)).not.toContain("secret");
  });

  it("counts a launchd relay with an unreadable vault as v1", async () => {
    const { migration } = harness({}, { macRelay: "stopped" });
    expect(await migration.inspect()).toMatchObject({ kind: "legacy", legacy: { hasBotToken: false, macRelay: "stopped" } });
  });

  it("imports the tokens and GlitchTip details into a setup draft, leaving v1 running", async () => {
    const { migration, items, ops } = harness(V1);
    const draft = await migration.importLegacy("default", "ru");
    expect(draft.glitchtip).toMatchObject({ baseUrl: "https://gt.example.com", organizationSlug: "acme" });
    expect(draft).toMatchObject({ id: "default", locale: "ru", relay: null, onboarding: { completedAt: null, currentStage: 1 } });
    expect(items.get("glitchtip-token")).toBe("gt-secret");
    expect(items.get("telegram-bot-token")).toBe("123:bot-secret");
    expect(ops).toEqual(["set glitchtip-token", "set telegram-bot-token", "phase imported"]);
  });

  it("never overwrites a token already saved under the new name", async () => {
    const { migration, items } = harness({ ...V1, "telegram-bot-token": "456:newer" });
    await migration.importLegacy("default", "en");
    expect(items.get("telegram-bot-token")).toBe("456:newer");
  });

  it("retires v1 once setup is done: Mac relay off, vault file, then the v1 Keychain items", async () => {
    const { migration, items, ops, phase } = harness({ ...V1, "glitchtip-token": "gt", "relay.env": "X='1'\n" }, { phase: "imported" });
    expect(await migration.retireLegacy(["web"])).toBe(true);
    expect(ops.slice(0, 2)).toEqual(["stop-mac-relay", "remove-vault"]);
    expect([...items.keys()].sort()).toEqual(["glitchtip-token", "relay.env"]);
    expect(LEGACY_KEYS.some((key) => items.has(key))).toBe(false);
    expect(phase()).toBe("retired");
  });

  it("keeps v1 delivering until an application covers its project", async () => {
    const { migration, ops, phase } = harness(V1, { phase: "imported" });
    expect(await migration.pending()).toEqual({ project: "web" });
    expect(await migration.retireLegacy(["api"])).toBe(false);
    expect(ops).toEqual([]);
    expect(phase()).toBe("imported");
    expect(await migration.retireLegacy(["api", "web"])).toBe(true);
    expect(await migration.pending()).toBeNull();
  });

  it("keeps a v1 install that saved no project on until the user turns it off", async () => {
    for (const project of [undefined, ""]) {
      const v1: Record<string, string> = { ...V1 };
      if (project === undefined) delete v1["glitchtip.project"];
      else v1["glitchtip.project"] = project;
      const { migration, ops, phase } = harness(v1, { phase: "imported" });
      expect(await migration.pending()).toEqual({ project: null });
      expect(await migration.retireLegacy(["web", "api"])).toBe(false);
      expect(ops).toEqual([]);
      expect(await migration.turnOffLegacy()).toBe(true);
      expect(ops.slice(0, 2)).toEqual(["stop-mac-relay", "remove-vault"]);
      expect(phase()).toBe("retired");
    }
  });

  it("leaves v1 alone unless it was imported", async () => {
    for (const start of [null, "retired"] as const) {
      const { migration, ops } = harness(V1, { phase: start });
      expect(await migration.retireLegacy(["web"])).toBe(false);
      expect(await migration.turnOffLegacy()).toBe(false);
      expect(ops).toEqual([]);
    }
  });

  it("keeps the v1 Keychain items and retries later when the vault cannot be verified", async () => {
    const { migration, items, phase } = harness(V1, { phase: "imported", failVault: true });
    await expect(migration.retireLegacy(["web"])).rejects.toThrow("vault-not-verified");
    expect(items.has("glitchtip.token")).toBe(true);
    expect(phase()).toBe("imported");
  });
});
