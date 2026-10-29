// Workspace state: the single versioned snapshot of everything the desktop
// app remembers about one GlitchTip Companion setup (GlitchTip connection,
// relay deployment, Telegram pairing, tracked applications, onboarding
// progress). Persisted through the store plugin to `workspace.json` under
// key "workspace" — the same `new LazyStore(path)` singleton pattern as the
// `settings` store in src/screens/{Daemon,Provision,Telegram}Screen.tsx.
//
// migrateWorkspace is the single validator for anything crossing this
// boundary: data freshly read from disk (which may be stale, hand-edited
// outside the app, or written by an older schema) and data about to be
// written. It never contains secrets — tokens and DSNs stay in the macOS
// Keychain (lib/secrets.ts); keep it that way when this type grows.
//
// STRICT VALIDATION, NOT COERCION (controller review of 732b15c): a
// default is filled only for a field that is ABSENT from the input, and
// only for the fields explicitly named below — locale, applications,
// relay, telegram, onboarding (as whole containers), and, per application,
// alertPreset/enabledStates. Every other field throws when it is present
// but malformed, or when it is required and missing. Two fields are a
// deliberate, narrow exception: ApplicationState.verifiedAt and
// AgentIntegration.verifiedAt are informational timestamps with no
// business invariant asked of them (unlike RelayDeployment.verifiedAt and
// onboarding.completedAt, which the review does constrain) — they are
// coerced to `null` when missing or malformed rather than rejected.
//
// Rejections name only the offending field paths ("relay.port",
// "telegram.chatId", ...), never the values that failed, so a thrown
// message is always safe to log or show as-is.

import { LazyStore } from "@tauri-apps/plugin-store";

import { isWorkspaceId } from "../lib/keychain";

export type WorkspaceState = {
  schemaVersion: 1;
  id: string;
  name: string;
  locale: "uz" | "ru" | "en";
  glitchtip: {
    baseUrl: string;
    organizationSlug: string;
    verifiedAt: string;
  };
  relay: RelayDeployment | null;
  telegram: TelegramWorkspace | null;
  applications: ApplicationState[];
  onboarding: {
    completedAt: string | null;
    currentStage: 1 | 2 | 3 | 4 | 5 | 6;
  };
};

export type ApplicationState = {
  id: string;
  name: string;
  projectSlug: string;
  environments: string[];
  topicId: number;
  topicColor: number;
  alertPreset: "chatty" | "balanced" | "quiet";
  enabledStates: Array<"error" | "warning" | "resolved" | "info" | "setup_complete" | "test">;
  repositoryPath: string | null;
  agent: AgentIntegration | null;
  verifiedAt: string | null;
};

export type AgentIntegration = {
  providers: Array<"codex" | "claude" | "other">;
  skillVersion: string;
  helperVersion: string;
  verifiedAt: string | null;
};

export type RelayDeployment = {
  host: string;
  user: string;
  port: number;
  /** SSH private key path; empty means ssh picks its default identities. */
  identityFile: string;
  dockerNetwork: string;
  deploymentDir: string;
  revision: string;
  previousRevision: string | null;
  status: "unknown" | "healthy" | "degraded";
  verifiedAt: string | null;
};

export type TelegramWorkspace = {
  botId: number;
  botUsername: string;
  chatId: number;
  chatTitle: string;
  allowedMemberIds: number[];
  pairedAt: string;
};

const STORE_FILE = "workspace.json";
const STORE_KEY = "workspace";

const store = new LazyStore(STORE_FILE);

// Info is opt-in: every other semantic state reaches the paired chat by
// default when an application is first added.
const DEFAULT_ENABLED_STATES: ApplicationState["enabledStates"] = [
  "error",
  "warning",
  "resolved",
  "setup_complete",
  "test",
];

const LOCALES: WorkspaceState["locale"][] = ["uz", "ru", "en"];
const ALERT_PRESETS: ApplicationState["alertPreset"][] = ["chatty", "balanced", "quiet"];
const ALERT_STATES: ApplicationState["enabledStates"] = [
  "error",
  "warning",
  "resolved",
  "info",
  "setup_complete",
  "test",
];
const AGENT_PROVIDERS: AgentIntegration["providers"] = ["codex", "claude", "other"];
const RELAY_STATUSES: RelayDeployment["status"][] = ["unknown", "healthy", "degraded"];

// Telegram Bot API private-supergroup ids are always negative and begin
// with "-100" followed by at least one more, non-zero-leading digit — that
// shape distinguishes them from a basic group (short negative id) or a
// private/user chat (positive id). Matched against the decimal string form.
const PRIVATE_SUPERGROUP_RE = /^-100[1-9]\d*$/;

// ---------------------------------------------------------------------------
// Primitive validators (type predicates — each narrows the checked value).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isStage(value: unknown): value is WorkspaceState["onboarding"]["currentStage"] {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6;
}

function isAbsoluteHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateSupergroupChatId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    PRIVATE_SUPERGROUP_RE.test(String(value))
  );
}

function hasNoDuplicates(values: unknown[]): boolean {
  return new Set(values).size === values.length;
}

// ---------------------------------------------------------------------------
// Compound validators for "non-empty array of unique, individually-valid
// entries" fields. Each is a single named predicate (rather than an inline
// `&&` chain at the call site) so TypeScript narrows the checked property
// directly in the caller's `if`.
// ---------------------------------------------------------------------------

function isValidEnvironments(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isNonEmptyString(entry)) &&
    hasNoDuplicates(value)
  );
}

function isValidEnabledStates(value: unknown): value is ApplicationState["enabledStates"] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isOneOf(entry, ALERT_STATES)) &&
    hasNoDuplicates(value)
  );
}

function isValidProviders(value: unknown): value is AgentIntegration["providers"] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isOneOf(entry, AGENT_PROVIDERS)) &&
    hasNoDuplicates(value)
  );
}

function isValidAllowedMemberIds(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => isPositiveSafeInteger(entry)) &&
    hasNoDuplicates(value)
  );
}

/** The two `verifiedAt` fields the review left uncovered — see module comment. */
function lenientNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// Per-object migration. Each function pushes a field-path token onto
// `errors` for every invariant it finds violated and always returns a
// concretely typed value (a harmless placeholder when invalid) — the
// placeholder is only ever discarded, because migrateWorkspace throws
// before returning its result when `errors` is non-empty.
// ---------------------------------------------------------------------------

function migrateGlitchtip(value: unknown, errors: string[]): WorkspaceState["glitchtip"] {
  const raw = isRecord(value) ? value : {};

  let baseUrl: string;
  if (isAbsoluteHttpUrl(raw.baseUrl)) {
    baseUrl = raw.baseUrl;
  } else {
    errors.push("glitchtip.baseUrl");
    baseUrl = "";
  }

  let organizationSlug: string;
  if (isNonEmptyString(raw.organizationSlug)) {
    organizationSlug = raw.organizationSlug;
  } else {
    errors.push("glitchtip.organizationSlug");
    organizationSlug = "";
  }

  let verifiedAt: string;
  if (isNonEmptyString(raw.verifiedAt)) {
    verifiedAt = raw.verifiedAt;
  } else {
    errors.push("glitchtip.verifiedAt");
    verifiedAt = "";
  }

  return { baseUrl, organizationSlug, verifiedAt };
}

function migrateAgent(value: unknown, errors: string[]): AgentIntegration | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    errors.push("applications.agent");
    return null;
  }
  const raw = value;

  let providers: AgentIntegration["providers"];
  if (isValidProviders(raw.providers)) {
    providers = raw.providers;
  } else {
    errors.push("applications.agent.providers");
    providers = [];
  }

  let skillVersion: string;
  if (isNonEmptyString(raw.skillVersion)) {
    skillVersion = raw.skillVersion;
  } else {
    errors.push("applications.agent.skillVersion");
    skillVersion = "";
  }

  let helperVersion: string;
  if (isNonEmptyString(raw.helperVersion)) {
    helperVersion = raw.helperVersion;
  } else {
    errors.push("applications.agent.helperVersion");
    helperVersion = "";
  }

  return { providers, skillVersion, helperVersion, verifiedAt: lenientNullableString(raw.verifiedAt) };
}

function migrateApplication(
  value: unknown,
  errors: string[],
  seenIds: Set<string>,
  seenTopicIds: Set<number>,
): ApplicationState {
  const raw = isRecord(value) ? value : {};

  let id: string;
  if (!isNonEmptyString(raw.id)) {
    errors.push("applications.id");
    id = "";
  } else if (seenIds.has(raw.id)) {
    errors.push("applications.id");
    id = raw.id;
  } else {
    seenIds.add(raw.id);
    id = raw.id;
  }

  let name: string;
  if (isNonEmptyString(raw.name)) {
    name = raw.name;
  } else {
    errors.push("applications.name");
    name = "";
  }

  let projectSlug: string;
  if (isNonEmptyString(raw.projectSlug)) {
    projectSlug = raw.projectSlug;
  } else {
    errors.push("applications.projectSlug");
    projectSlug = "";
  }

  let topicId: number;
  if (!isPositiveSafeInteger(raw.topicId)) {
    errors.push("applications.topicId");
    topicId = 0;
  } else if (seenTopicIds.has(raw.topicId)) {
    errors.push("applications.topicId");
    topicId = raw.topicId;
  } else {
    seenTopicIds.add(raw.topicId);
    topicId = raw.topicId;
  }

  let topicColor: number;
  if (isNonNegativeSafeInteger(raw.topicColor)) {
    topicColor = raw.topicColor;
  } else {
    errors.push("applications.topicColor");
    topicColor = 0;
  }

  let environments: string[];
  if (isValidEnvironments(raw.environments)) {
    environments = raw.environments;
  } else {
    errors.push("applications.environments");
    environments = [];
  }

  // Optional-with-default: only an ABSENT key defaults silently.
  let enabledStates: ApplicationState["enabledStates"];
  if (raw.enabledStates === undefined) {
    enabledStates = DEFAULT_ENABLED_STATES;
  } else if (isValidEnabledStates(raw.enabledStates)) {
    enabledStates = raw.enabledStates;
  } else {
    errors.push("applications.enabledStates");
    enabledStates = DEFAULT_ENABLED_STATES;
  }

  let alertPreset: ApplicationState["alertPreset"];
  if (raw.alertPreset === undefined) {
    alertPreset = "balanced";
  } else if (isOneOf(raw.alertPreset, ALERT_PRESETS)) {
    alertPreset = raw.alertPreset;
  } else {
    errors.push("applications.alertPreset");
    alertPreset = "balanced";
  }

  // Required-but-nullable: the key must be present as `null` or a
  // non-empty string — an absent key is a missing required field.
  let repositoryPath: string | null;
  if (isNullableNonEmptyString(raw.repositoryPath)) {
    repositoryPath = raw.repositoryPath;
  } else {
    errors.push("applications.repositoryPath");
    repositoryPath = null;
  }

  const agent = migrateAgent(raw.agent, errors);

  return {
    id,
    name,
    projectSlug,
    environments,
    topicId,
    topicColor,
    alertPreset,
    enabledStates,
    repositoryPath,
    agent,
    verifiedAt: lenientNullableString(raw.verifiedAt),
  };
}

function migrateRelay(value: unknown, errors: string[]): RelayDeployment | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    errors.push("relay");
    return null;
  }
  const raw = value;

  let host: string;
  if (isNonEmptyString(raw.host)) host = raw.host;
  else { errors.push("relay.host"); host = ""; }

  let user: string;
  if (isNonEmptyString(raw.user)) user = raw.user;
  else { errors.push("relay.user"); user = ""; }

  let port: number;
  if (isValidPort(raw.port)) port = raw.port;
  else { errors.push("relay.port"); port = 0; }

  // Workspaces saved before the key path was kept have none: ssh defaults.
  let identityFile: string;
  if (raw.identityFile === undefined) identityFile = "";
  else if (typeof raw.identityFile === "string") identityFile = raw.identityFile;
  else { errors.push("relay.identityFile"); identityFile = ""; }

  let dockerNetwork: string;
  if (isNonEmptyString(raw.dockerNetwork)) dockerNetwork = raw.dockerNetwork;
  else { errors.push("relay.dockerNetwork"); dockerNetwork = ""; }

  let deploymentDir: string;
  if (isNonEmptyString(raw.deploymentDir)) deploymentDir = raw.deploymentDir;
  else { errors.push("relay.deploymentDir"); deploymentDir = ""; }

  let revision: string;
  if (isNonEmptyString(raw.revision)) revision = raw.revision;
  else { errors.push("relay.revision"); revision = ""; }

  let previousRevision: string | null;
  if (isNullableNonEmptyString(raw.previousRevision)) previousRevision = raw.previousRevision;
  else { errors.push("relay.previousRevision"); previousRevision = null; }

  let status: RelayDeployment["status"];
  if (isOneOf(raw.status, RELAY_STATUSES)) status = raw.status;
  else { errors.push("relay.status"); status = "unknown"; }

  let verifiedAt: string | null;
  if (isNullableNonEmptyString(raw.verifiedAt)) verifiedAt = raw.verifiedAt;
  else { errors.push("relay.verifiedAt"); verifiedAt = null; }

  return {
    host,
    user,
    port,
    identityFile,
    dockerNetwork,
    deploymentDir,
    revision,
    previousRevision,
    status,
    verifiedAt,
  };
}

function migrateTelegram(value: unknown, errors: string[]): TelegramWorkspace | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    errors.push("telegram");
    return null;
  }
  const raw = value;

  let botId: number;
  if (isPositiveSafeInteger(raw.botId)) botId = raw.botId;
  else { errors.push("telegram.botId"); botId = 0; }

  let botUsername: string;
  if (isNonEmptyString(raw.botUsername)) botUsername = raw.botUsername;
  else { errors.push("telegram.botUsername"); botUsername = ""; }

  let chatTitle: string;
  if (isNonEmptyString(raw.chatTitle)) chatTitle = raw.chatTitle;
  else { errors.push("telegram.chatTitle"); chatTitle = ""; }

  let chatId: number;
  if (isPrivateSupergroupChatId(raw.chatId)) chatId = raw.chatId;
  else { errors.push("telegram.chatId"); chatId = 0; }

  let allowedMemberIds: number[];
  if (isValidAllowedMemberIds(raw.allowedMemberIds)) allowedMemberIds = raw.allowedMemberIds;
  else { errors.push("telegram.allowedMemberIds"); allowedMemberIds = []; }

  let pairedAt: string;
  if (isNonEmptyString(raw.pairedAt)) pairedAt = raw.pairedAt;
  else { errors.push("telegram.pairedAt"); pairedAt = ""; }

  return { botId, botUsername, chatId, chatTitle, allowedMemberIds, pairedAt };
}

function migrateOnboarding(value: unknown, errors: string[]): WorkspaceState["onboarding"] {
  if (value === undefined) {
    return { completedAt: null, currentStage: 1 };
  }
  if (!isRecord(value)) {
    errors.push("onboarding");
    return { completedAt: null, currentStage: 1 };
  }
  const raw = value;

  let completedAt: string | null;
  if (isNullableNonEmptyString(raw.completedAt)) completedAt = raw.completedAt;
  else { errors.push("onboarding.completedAt"); completedAt = null; }

  let currentStage: WorkspaceState["onboarding"]["currentStage"];
  if (isStage(raw.currentStage)) currentStage = raw.currentStage;
  else { errors.push("onboarding.currentStage"); currentStage = 1; }

  return { completedAt, currentStage };
}

/**
 * Validate an unknown value into a `WorkspaceState`: the sole entry point
 * for data crossing the persistence boundary (disk → memory and memory →
 * disk). Fills deterministic defaults for the fields listed in the module
 * comment when they are ABSENT, and throws an `Error` naming every invalid
 * field — never the values that failed — for anything else that is
 * present-but-malformed or a missing required field.
 */
export function migrateWorkspace(input: unknown): WorkspaceState {
  const raw = isRecord(input) ? input : {};
  const errors: string[] = [];

  if (raw.schemaVersion !== 1) {
    errors.push("schemaVersion");
  }

  // The id names this workspace's Keychain items, so it must satisfy the
  // same rule the Keychain commands enforce.
  let id: string;
  if (typeof raw.id === "string" && isWorkspaceId(raw.id)) id = raw.id;
  else { errors.push("id"); id = ""; }

  let name: string;
  if (isNonEmptyString(raw.name)) name = raw.name;
  else { errors.push("name"); name = ""; }

  let locale: WorkspaceState["locale"];
  if (raw.locale === undefined) {
    locale = "uz";
  } else if (isOneOf(raw.locale, LOCALES)) {
    locale = raw.locale;
  } else {
    errors.push("locale");
    locale = "uz";
  }

  const glitchtip = migrateGlitchtip(raw.glitchtip, errors);

  let applications: ApplicationState[];
  if (raw.applications === undefined) {
    applications = [];
  } else if (!Array.isArray(raw.applications)) {
    errors.push("applications");
    applications = [];
  } else {
    const seenIds = new Set<string>();
    const seenTopicIds = new Set<number>();
    applications = raw.applications.map((entry) =>
      migrateApplication(entry, errors, seenIds, seenTopicIds),
    );
  }

  const relay = migrateRelay(raw.relay, errors);
  const telegram = migrateTelegram(raw.telegram, errors);
  const onboarding = migrateOnboarding(raw.onboarding, errors);

  if (errors.length > 0) {
    const unique = Array.from(new Set(errors));
    throw new Error(`Invalid workspace state: ${unique.join(", ")}`);
  }

  return { schemaVersion: 1, id, name, locale, glitchtip, relay, telegram, applications, onboarding };
}

/** Build a valid, freshly defaulted workspace (schema v1, stage 1, no applications). */
export function createWorkspace(params: {
  id: string;
  name: string;
  glitchtip: WorkspaceState["glitchtip"];
}): WorkspaceState {
  return migrateWorkspace({
    schemaVersion: 1,
    id: params.id,
    name: params.name,
    glitchtip: params.glitchtip,
  });
}

/** Read the persisted workspace, migrating/validating it. `null` when nothing is stored yet. */
export async function loadWorkspace(): Promise<WorkspaceState | null> {
  const raw = await store.get<unknown>(STORE_KEY);
  if (raw === undefined) return null;
  return migrateWorkspace(raw);
}

/** Validate `state` and persist it. Nothing is written when validation fails. */
export async function saveWorkspace(state: WorkspaceState): Promise<void> {
  const migrated = migrateWorkspace(state);
  await store.set(STORE_KEY, migrated);
  await store.save();
}

/**
 * The in-memory workspace a first run starts from. It cannot be saved: it has
 * no GlitchTip connection yet, so saveWorkspace rejects it until setup stage 1
 * fills `glitchtip`, and nothing reaches disk before the first proof.
 */
export function draftWorkspace(id: string, locale: WorkspaceState["locale"]): WorkspaceState {
  return {
    schemaVersion: 1,
    id,
    name: "Main",
    locale,
    glitchtip: { baseUrl: "", organizationSlug: "", verifiedAt: "" },
    relay: null,
    telegram: null,
    applications: [],
    onboarding: { completedAt: null, currentStage: 1 },
  };
}

/** The first supported language in the system's preference order; Uzbek otherwise. */
export function preferredLocale(
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages,
): WorkspaceState["locale"] {
  for (const tag of languages) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "uz" || base === "ru" || base === "en") return base;
  }
  return "uz";
}
