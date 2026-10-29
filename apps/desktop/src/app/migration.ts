// Moving a v1 install (the wizard and its launchd relay on this Mac) to the Linux relay.
//
// bootstrap() copies the v1 file vault into the Keychain under LEGACY_WORKSPACE_ID, with the
// vault's dotted key names. The move then reuses the setup assistant, the one path that deploys,
// pairs and verifies a relay:
//   1. importLegacy copies the two tokens to the names setup reads and returns a draft workspace
//      with the GlitchTip address and organization filled in. Nothing of v1 changes, so the Mac
//      relay keeps delivering while setup runs.
//   2. Setup deploys the Linux relay and points the GlitchTip alert rule at it (provisionInventory
//      updates a rule kept from v1).
//   3. retireLegacy, once a saved application for v1's project has passed verification, turns the
//      Mac relay off, deletes the verified file vault, then the dotted Keychain items. Until then
//      v1 keeps delivering for that project; a v1 that never saved its project stays on until the
//      user turns it off (turnOffLegacy). Every step is safe to repeat, and a failure leaves the
//      phase at "imported", so the next save or launch tries again.
// "Set up fresh" skips all three and leaves v1 alone.
//
// Side effects are injected (`MigrationDeps`); `defaultDeps()` wires the real Keychain, launchd
// and settings store. The preview reports which secrets exist, never their values.

import type { DaemonStatus } from "../lib/daemon";
import { draftWorkspace, type WorkspaceState } from "./workspace";

export type LegacyInstall = {
  glitchtipUrl: string | null;
  organizationSlug: string | null;
  /** The one project v1 delivered alerts for. */
  projectSlug: string | null;
  hasGlitchtipToken: boolean;
  hasBotToken: boolean;
  macRelay: DaemonStatus;
};

export type MigrationPreview = { kind: "fresh" } | { kind: "legacy"; legacy: LegacyInstall };

export type MigrationPhase = "imported" | "retired";

/** v1 still running after the move: the project it was set up for, or null when it saved none. */
export type LegacyPending = { project: string | null };

export type MigrationDeps = {
  /** Keychain item names under LEGACY_WORKSPACE_ID. */
  presence(): Promise<string[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  macRelay(): Promise<DaemonStatus>;
  /** Unloads the launchd relay and removes its plist. */
  stopMacRelay(): Promise<void>;
  /** Deletes the v1 vault file only once every key in it reads back from the Keychain. */
  removeFileVault(): Promise<void>;
  loadPhase(): Promise<MigrationPhase | null>;
  savePhase(phase: MigrationPhase): Promise<void>;
};

/** The v1 vault's keys (daemon.ts VAULT_TO_ENV, plus what the wizard showed). */
export const LEGACY_KEYS = [
  "glitchtip.url",
  "glitchtip.org",
  "glitchtip.project",
  "glitchtip.token",
  "telegram.botToken",
  "telegram.chatId",
  "telegram.chatTitle",
] as const;

/** v1 name → the name the setup assistant reads. */
const CARRIED_TOKENS = [
  ["glitchtip.token", "glitchtip-token"],
  ["telegram.botToken", "telegram-bot-token"],
] as const;

export function createMigration(deps: MigrationDeps) {
  async function inspect(): Promise<MigrationPreview> {
    const keys = (await deps.presence()).filter((key) => (LEGACY_KEYS as readonly string[]).includes(key));
    const macRelay = await deps.macRelay();
    if (keys.length === 0 && macRelay === "not-installed") return { kind: "fresh" };
    const read = (key: string) => (keys.includes(key) ? deps.get(key) : Promise.resolve(null));
    return {
      kind: "legacy",
      legacy: {
        glitchtipUrl: await read("glitchtip.url"),
        organizationSlug: await read("glitchtip.org"),
        projectSlug: await read("glitchtip.project"),
        hasGlitchtipToken: keys.includes("glitchtip.token"),
        hasBotToken: keys.includes("telegram.botToken"),
        macRelay,
      },
    };
  }

  async function importLegacy(workspaceId: string, locale: WorkspaceState["locale"]): Promise<WorkspaceState> {
    const preview = await inspect();
    const present = await deps.presence();
    for (const [from, to] of CARRIED_TOKENS) {
      // A token already saved under the new name is newer than v1's: never overwrite it.
      if (present.includes(to) || !present.includes(from)) continue;
      const value = await deps.get(from);
      if (value) await deps.set(to, value);
    }
    await deps.savePhase("imported");
    const draft = draftWorkspace(workspaceId, locale);
    if (preview.kind === "fresh") return draft;
    return {
      ...draft,
      glitchtip: {
        ...draft.glitchtip,
        baseUrl: preview.legacy.glitchtipUrl ?? "",
        organizationSlug: preview.legacy.organizationSlug ?? "",
      },
    };
  }

  /** v1 while it still runs after the move; null when it was never imported, or once it is retired. */
  async function pending(): Promise<LegacyPending | null> {
    if ((await deps.loadPhase()) !== "imported") return null;
    if (!(await deps.presence()).includes("glitchtip.project")) return { project: null };
    return { project: (await deps.get("glitchtip.project")) || null };
  }

  /**
   * True when this call finished retiring v1. `projects` are the projects of verified applications:
   * v1 stays on while none of them is the project it was set up for, and while that is unknown.
   */
  async function retireLegacy(projects: readonly string[]): Promise<boolean> {
    const legacy = await pending();
    if (legacy === null || legacy.project === null || !projects.includes(legacy.project)) return false;
    await retire();
    return true;
  }

  /** Retires v1 at the user's word, whatever it still delivers. */
  async function turnOffLegacy(): Promise<boolean> {
    if ((await pending()) === null) return false;
    await retire();
    return true;
  }

  async function retire(): Promise<void> {
    if ((await deps.macRelay()) !== "not-installed") await deps.stopMacRelay();
    await deps.removeFileVault();
    const present = await deps.presence();
    for (const key of LEGACY_KEYS) {
      if (present.includes(key)) await deps.remove(key);
    }
    await deps.savePhase("retired");
  }

  return { inspect, importLegacy, pending, retireLegacy, turnOffLegacy };
}

// ---------------------------------------------------------------------------
// Real wiring (Tauri). Not unit-tested: every seam above is injected.

async function defaultDeps(): Promise<MigrationDeps> {
  const [{ LazyStore }, daemon, keychain, secrets] = await Promise.all([
    import("@tauri-apps/plugin-store"),
    import("../lib/daemon"),
    import("../lib/keychain"),
    import("../lib/secrets"),
  ]);
  const settings = new LazyStore("settings.json");
  const phaseKey = "migration.phase";
  const id = secrets.LEGACY_WORKSPACE_ID;
  return {
    presence: () => keychain.secretPresence(id),
    get: (key) => secrets.get(id, key),
    set: (key, value) => secrets.set(id, key, value),
    remove: (key) => secrets.remove(id, key),
    macRelay: async () => (await daemon.getDaemonStatusDetail()).state,
    stopMacRelay: async () => void (await daemon.setDaemonEnabled(false)),
    removeFileVault: async () => void (await keychain.removeFileVault(id)),
    loadPhase: async () => {
      const phase = await settings.get<string>(phaseKey);
      return phase === "imported" || phase === "retired" ? phase : null;
    },
    savePhase: async (phase) => {
      await settings.set(phaseKey, phase);
      await settings.save();
    },
  };
}

let cached: Promise<ReturnType<typeof createMigration>> | null = null;
function real() {
  cached ??= defaultDeps().then(createMigration);
  return cached;
}

export const inspectLegacyState = async () => (await real()).inspect();
export const importLegacyInstall = async (workspaceId: string, locale: WorkspaceState["locale"]) =>
  (await real()).importLegacy(workspaceId, locale);
export const legacyPending = async () => (await real()).pending();
export const retireLegacyInstall = async (projects: readonly string[]) => (await real()).retireLegacy(projects);
export const turnOffLegacyInstall = async () => (await real()).turnOffLegacy();
