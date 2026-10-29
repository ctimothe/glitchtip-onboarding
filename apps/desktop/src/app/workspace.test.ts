import { beforeEach, describe, expect, it, vi } from "vitest";

// LazyStore is a class (constructor), so it needs `vi.hoisted` — a plain
// `vi.mock` factory cannot reference outer-scope mock fns (they are not
// yet initialized when the hoisted factory runs). Keeping get/set/save as
// shared vi.fn()s lets both workspace.ts's module-level `new LazyStore(...)`
// singleton and this file's assertions see the same in-memory store.
const { getMock, setMock, saveMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(function LazyStoreMock() {
    return { get: getMock, set: setMock, save: saveMock };
  }),
}));

import {
  createWorkspace,
  draftWorkspace,
  loadWorkspace,
  migrateWorkspace,
  preferredLocale,
  saveWorkspace,
} from "./workspace";
import { isWorkspaceId } from "../lib/keychain";

const GLITCHTIP = {
  baseUrl: "https://errors.example.com",
  organizationSlug: "kelajak-merosi",
  verifiedAt: "2026-09-20T00:00:00.000Z",
};

function minimalRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "ws-1",
    name: "Kelajak Merosi",
    glitchtip: GLITCHTIP,
    ...overrides,
  };
}

function rawApplication(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "app-1",
    name: "billing-api",
    projectSlug: "billing-api",
    environments: ["production"],
    topicId: 10,
    topicColor: 1,
    // repositoryPath and agent are required-but-nullable under strict
    // validation (they are not in migrateWorkspace's default-fill list),
    // so every fixture must supply them explicitly.
    repositoryPath: null,
    agent: null,
    ...overrides,
  };
}

// A fully populated, strictly-valid raw workspace — the base fixture for
// the "passes through unchanged" test and for every row of the malformed-
// field table below (each row clones this and corrupts exactly one field).
function validWorkspaceRaw(): Record<string, unknown> {
  return structuredClone({
    schemaVersion: 1,
    id: "ws-1",
    name: "Kelajak Merosi",
    locale: "ru",
    glitchtip: GLITCHTIP,
    relay: {
      host: "relay.example.com",
      user: "deploy",
      port: 8443,
      identityFile: "/Users/me/.ssh/relay_ed25519",
      dockerNetwork: "glitchtip_net",
      deploymentDir: "/opt/relay",
      revision: "abc123",
      previousRevision: "abc122",
      status: "healthy",
      verifiedAt: "2026-09-20T00:00:00.000Z",
    },
    telegram: {
      botId: 555,
      botUsername: "glitchtip_relay_bot",
      chatId: -1001234567890,
      chatTitle: "Kelajak Merosi Alerts",
      allowedMemberIds: [111, 222],
      pairedAt: "2026-09-20T00:00:00.000Z",
    },
    applications: [
      {
        id: "app-1",
        name: "billing-api",
        projectSlug: "billing-api",
        environments: ["production", "staging"],
        topicId: 10,
        topicColor: 1,
        alertPreset: "chatty",
        enabledStates: ["error", "warning", "info"],
        repositoryPath: "/Users/dev/billing-api",
        agent: {
          providers: ["codex", "claude"],
          skillVersion: "1.2.0",
          helperVersion: "0.4.1",
          verifiedAt: "2026-09-20T00:00:00.000Z",
        },
        verifiedAt: "2026-09-20T00:00:00.000Z",
      },
    ],
    onboarding: { completedAt: "2026-09-20T00:00:00.000Z", currentStage: 6 },
  });
}

function firstApp(raw: Record<string, unknown>): Record<string, unknown> {
  const apps = raw.applications as Record<string, unknown>[];
  return apps[0];
}

function nested(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  return raw[key] as Record<string, unknown>;
}

type MalformedCase = {
  /** Field-name token the thrown message must contain. */
  field: string;
  /** Corrupt exactly one field of an otherwise-valid raw workspace. */
  apply: (raw: Record<string, unknown>) => void;
  /**
   * A distinctive bad value the message must NOT contain. Omitted for
   * fields whose violation is emptiness itself (checking a message
   * doesn't contain "" is vacuous — there's nothing to leak).
   */
  badValue?: string;
};

const MALFORMED_CASES: MalformedCase[] = [
  { field: "id", apply: (raw) => { raw.id = ""; } },
  { field: "name", apply: (raw) => { raw.name = ""; } },
  { field: "locale", apply: (raw) => { raw.locale = "fr"; }, badValue: "fr" },

  {
    field: "glitchtip.baseUrl",
    apply: (raw) => { nested(raw, "glitchtip").baseUrl = "not-a-valid-url"; },
    badValue: "not-a-valid-url",
  },
  {
    field: "glitchtip.organizationSlug",
    apply: (raw) => { nested(raw, "glitchtip").organizationSlug = ""; },
  },
  {
    field: "glitchtip.verifiedAt",
    apply: (raw) => { nested(raw, "glitchtip").verifiedAt = ""; },
  },

  { field: "applications.id", apply: (raw) => { firstApp(raw).id = ""; } },
  { field: "applications.name", apply: (raw) => { firstApp(raw).name = ""; } },
  { field: "applications.projectSlug", apply: (raw) => { firstApp(raw).projectSlug = ""; } },
  {
    field: "applications.topicId",
    apply: (raw) => { firstApp(raw).topicId = -7; },
    badValue: "-7",
  },
  {
    field: "applications.topicColor",
    apply: (raw) => { firstApp(raw).topicColor = -3; },
    badValue: "-3",
  },
  {
    field: "applications.environments",
    apply: (raw) => { firstApp(raw).environments = ["production", "production"]; },
  },
  {
    field: "applications.enabledStates",
    apply: (raw) => { firstApp(raw).enabledStates = ["error", "bogus-state"]; },
    badValue: "bogus-state",
  },
  {
    field: "applications.alertPreset",
    apply: (raw) => { firstApp(raw).alertPreset = "loud"; },
    badValue: "loud",
  },
  {
    field: "applications.repositoryPath",
    apply: (raw) => { delete firstApp(raw).repositoryPath; },
  },
  { field: "applications.agent", apply: (raw) => { delete firstApp(raw).agent; } },
  {
    field: "applications.agent.providers",
    apply: (raw) => { (firstApp(raw).agent as Record<string, unknown>).providers = []; },
  },
  {
    field: "applications.agent.skillVersion",
    apply: (raw) => { (firstApp(raw).agent as Record<string, unknown>).skillVersion = ""; },
  },
  {
    field: "applications.agent.helperVersion",
    apply: (raw) => { (firstApp(raw).agent as Record<string, unknown>).helperVersion = ""; },
  },

  { field: "relay.host", apply: (raw) => { nested(raw, "relay").host = ""; } },
  { field: "relay.user", apply: (raw) => { nested(raw, "relay").user = ""; } },
  { field: "relay.dockerNetwork", apply: (raw) => { nested(raw, "relay").dockerNetwork = ""; } },
  { field: "relay.deploymentDir", apply: (raw) => { nested(raw, "relay").deploymentDir = ""; } },
  { field: "relay.revision", apply: (raw) => { nested(raw, "relay").revision = ""; } },
  {
    field: "relay.port",
    apply: (raw) => { nested(raw, "relay").port = 99999; },
    badValue: "99999",
  },
  {
    field: "relay.status",
    apply: (raw) => { nested(raw, "relay").status = "flaky"; },
    badValue: "flaky",
  },
  {
    field: "relay.previousRevision",
    apply: (raw) => { delete nested(raw, "relay").previousRevision; },
  },
  { field: "relay.verifiedAt", apply: (raw) => { delete nested(raw, "relay").verifiedAt; } },

  {
    field: "telegram.botId",
    apply: (raw) => { nested(raw, "telegram").botId = -9; },
    badValue: "-9",
  },
  { field: "telegram.botUsername", apply: (raw) => { nested(raw, "telegram").botUsername = ""; } },
  { field: "telegram.chatTitle", apply: (raw) => { nested(raw, "telegram").chatTitle = ""; } },
  {
    field: "telegram.chatId",
    apply: (raw) => { nested(raw, "telegram").chatId = -42; },
    badValue: "-42",
  },
  {
    field: "telegram.allowedMemberIds",
    apply: (raw) => { nested(raw, "telegram").allowedMemberIds = []; },
  },
  { field: "telegram.pairedAt", apply: (raw) => { nested(raw, "telegram").pairedAt = ""; } },

  {
    field: "onboarding.completedAt",
    apply: (raw) => { delete nested(raw, "onboarding").completedAt; },
  },
  {
    field: "onboarding.currentStage",
    apply: (raw) => { nested(raw, "onboarding").currentStage = 9; },
    badValue: "9",
  },
];

beforeEach(() => {
  getMock.mockReset();
  setMock.mockReset();
  saveMock.mockReset();
});

describe("workspace state", () => {
  describe("migrateWorkspace defaults", () => {
    it("fills deterministic defaults for a minimal valid input", () => {
      const result = migrateWorkspace(minimalRaw());
      expect(result).toEqual({
        schemaVersion: 1,
        id: "ws-1",
        name: "Kelajak Merosi",
        locale: "uz",
        glitchtip: GLITCHTIP,
        relay: null,
        telegram: null,
        applications: [],
        onboarding: { completedAt: null, currentStage: 1 },
      });
    });

    it("defaults a missing locale to uz but keeps an explicit ru/en", () => {
      expect(migrateWorkspace(minimalRaw()).locale).toBe("uz");
      expect(migrateWorkspace(minimalRaw({ locale: "ru" })).locale).toBe("ru");
      expect(migrateWorkspace(minimalRaw({ locale: "en" })).locale).toBe("en");
    });

    it("defaults an application's alertPreset to balanced and enabledStates to every state but info", () => {
      const result = migrateWorkspace(
        minimalRaw({ applications: [rawApplication()] }),
      );
      const app = result.applications[0];
      expect(app.alertPreset).toBe("balanced");
      expect(app.enabledStates).toEqual([
        "error",
        "warning",
        "resolved",
        "setup_complete",
        "test",
      ]);
      expect(app.enabledStates).not.toContain("info");
    });

    it("passes through an already-valid, fully populated workspace unchanged", () => {
      const raw = validWorkspaceRaw();
      expect(migrateWorkspace(raw)).toEqual(validWorkspaceRaw());
    });
  });

  describe("migrateWorkspace strict field validation", () => {
    // Controller review (732b15c) required strict validation to replace
    // silent coercion: migrateWorkspace may only default the fields
    // explicitly listed (locale, applications, relay, telegram, onboarding,
    // per-app alertPreset/enabledStates when the KEY IS ABSENT). Every
    // other field — present-but-malformed, or a required field that is
    // missing entirely — must throw, naming the field and never the value.
    // One row per field from that review; each clones a fully-valid
    // workspace and corrupts exactly one field, so the assertion isolates
    // that field's own invariant.
    it.each(MALFORMED_CASES)(
      "rejects a malformed $field",
      ({ field, apply, badValue }) => {
        const raw = validWorkspaceRaw();
        apply(raw);

        let error: Error | null = null;
        try {
          migrateWorkspace(raw);
        } catch (err) {
          error = err as Error;
        }

        expect(error).not.toBeNull();
        expect(error?.message).toContain(field);
        if (badValue !== undefined) {
          expect(error?.message).not.toContain(badValue);
        }
      },
    );

    it("still accepts the unmodified base fixture (sanity check for the table above)", () => {
      expect(() => migrateWorkspace(validWorkspaceRaw())).not.toThrow();
    });
  });

  describe("migrateWorkspace invariants", () => {
    it("rejects a schemaVersion other than 1", () => {
      expect(() => migrateWorkspace(minimalRaw({ schemaVersion: 2 }))).toThrow(
        /schemaVersion/,
      );
    });

    it("rejects a missing schemaVersion", () => {
      const rest = minimalRaw();
      delete rest.schemaVersion;
      expect(() => migrateWorkspace(rest)).toThrow(/schemaVersion/);
    });

    it("rejects duplicate application ids", () => {
      expect(() =>
        migrateWorkspace(
          minimalRaw({
            applications: [
              rawApplication({ id: "app-1", topicId: 10 }),
              rawApplication({ id: "app-1", topicId: 20 }),
            ],
          }),
        ),
      ).toThrow(/applications\.id/);
    });

    it("rejects duplicate topic ids", () => {
      expect(() =>
        migrateWorkspace(
          minimalRaw({
            applications: [
              rawApplication({ id: "app-1", topicId: 10 }),
              rawApplication({ id: "app-2", topicId: 10 }),
            ],
          }),
        ),
      ).toThrow(/applications\.topicId/);
    });

    it("rejects an application with empty environments", () => {
      expect(() =>
        migrateWorkspace(
          minimalRaw({ applications: [rawApplication({ environments: [] })] }),
        ),
      ).toThrow(/applications\.environments/);
    });

    it("rejects a telegram.chatId that is not a private supergroup id (basic group)", () => {
      expect(() =>
        migrateWorkspace(
          minimalRaw({
            telegram: {
              botId: 1,
              botUsername: "bot",
              chatId: -123456789,
              chatTitle: "x",
              allowedMemberIds: [111],
              pairedAt: "2026-09-20T00:00:00.000Z",
            },
          }),
        ),
      ).toThrow(/telegram\.chatId/);
    });

    it("rejects a telegram.chatId that is not a private supergroup id (positive/user chat)", () => {
      expect(() =>
        migrateWorkspace(
          minimalRaw({
            telegram: {
              botId: 1,
              botUsername: "bot",
              chatId: 123456789,
              chatTitle: "x",
              allowedMemberIds: [111],
              pairedAt: "2026-09-20T00:00:00.000Z",
            },
          }),
        ),
      ).toThrow(/telegram\.chatId/);
    });

    it("accepts a valid private supergroup chatId", () => {
      const result = migrateWorkspace(
        minimalRaw({
          telegram: {
            botId: 1,
            botUsername: "bot",
            chatId: -1001234567890,
            chatTitle: "x",
            allowedMemberIds: [111],
            pairedAt: "2026-09-20T00:00:00.000Z",
          },
        }),
      );
      expect(result.telegram?.chatId).toBe(-1001234567890);
    });

    it("rejects an out-of-range relay.port", () => {
      expect(() =>
        migrateWorkspace(
          minimalRaw({
            relay: {
              host: "h",
              user: "u",
              port: 0,
              dockerNetwork: "n",
              deploymentDir: "/d",
              revision: "r",
              previousRevision: null,
              status: "unknown",
              verifiedAt: null,
            },
          }),
        ),
      ).toThrow(/relay\.port/);

      expect(() =>
        migrateWorkspace(
          minimalRaw({
            relay: {
              host: "h",
              user: "u",
              port: 65536,
              dockerNetwork: "n",
              deploymentDir: "/d",
              revision: "r",
              previousRevision: null,
              status: "unknown",
              verifiedAt: null,
            },
          }),
        ),
      ).toThrow(/relay\.port/);
    });

    it("reads a relay saved before the SSH key path was kept as using ssh defaults", () => {
      const relay = { host: "h", user: "u", port: 22, dockerNetwork: "n", deploymentDir: "/d", revision: "r", previousRevision: null, status: "unknown", verifiedAt: null };
      expect(migrateWorkspace(minimalRaw({ relay })).relay?.identityFile).toBe("");
      expect(() => migrateWorkspace(minimalRaw({ relay: { ...relay, identityFile: 42 } }))).toThrow(/relay\.identityFile/);
    });

    it("accepts relay.port at the 1 and 65535 boundaries", () => {
      for (const port of [1, 65535]) {
        const result = migrateWorkspace(
          minimalRaw({
            relay: {
              host: "h",
              user: "u",
              port,
              dockerNetwork: "n",
              deploymentDir: "/d",
              revision: "r",
              previousRevision: null,
              status: "unknown",
              verifiedAt: null,
            },
          }),
        );
        expect(result.relay?.port).toBe(port);
      }
    });

    it("rejects an id that is not a valid Keychain workspace ID, without echoing it", () => {
      for (const bad of ["../acme", "WS-1", "ws_1", "-ws", "ws.1", "ws 1", "a".repeat(64)]) {
        let error: Error | null = null;
        try {
          migrateWorkspace(minimalRaw({ id: bad }));
        } catch (err) {
          error = err as Error;
        }
        expect(error?.message, bad).toBe("Invalid workspace state: id");
      }
      expect(migrateWorkspace(minimalRaw({ id: "default" })).id).toBe("default");
      expect(migrateWorkspace(minimalRaw({ id: "a".repeat(63) })).id).toBe("a".repeat(63));
    });

    it("accepts exactly the workspace IDs the Keychain accepts", () => {
      for (const id of ["ws-1", "0-team-9", "default", "Acme", "acme/x", "acme_x", "", "-x"]) {
        let accepted = true;
        try {
          migrateWorkspace(minimalRaw({ id }));
        } catch {
          accepted = false;
        }
        expect(accepted, JSON.stringify(id)).toBe(isWorkspaceId(id));
      }
    });

    it("rejects an onboarding.currentStage outside 1..6", () => {
      expect(() =>
        migrateWorkspace(minimalRaw({ onboarding: { completedAt: null, currentStage: 0 } })),
      ).toThrow(/onboarding\.currentStage/);
      expect(() =>
        migrateWorkspace(minimalRaw({ onboarding: { completedAt: null, currentStage: 7 } })),
      ).toThrow(/onboarding\.currentStage/);
    });

    it("lists only field names in the error message, never the invalid values", () => {
      const secretLookingValue = "sk-live-do-not-leak-this-token";
      let error: Error | null = null;
      try {
        migrateWorkspace({
          schemaVersion: 99,
          id: "ws-1",
          name: secretLookingValue,
          glitchtip: GLITCHTIP,
          relay: {
            host: "h",
            user: "u",
            port: -5,
            dockerNetwork: "n",
            deploymentDir: "/d",
            revision: "r",
            previousRevision: null,
            status: "unknown",
            verifiedAt: null,
          },
        });
      } catch (err) {
        error = err as Error;
      }
      expect(error).not.toBeNull();
      expect(error?.message).toContain("schemaVersion");
      expect(error?.message).toContain("relay.port");
      expect(error?.message).not.toContain("99");
      expect(error?.message).not.toContain("-5");
      expect(error?.message).not.toContain(secretLookingValue);
    });
  });

  describe("createWorkspace", () => {
    it("produces a valid, fully defaulted fresh workspace", () => {
      const workspace = createWorkspace({ id: "ws-1", name: "Kelajak Merosi", glitchtip: GLITCHTIP });
      expect(workspace).toEqual({
        schemaVersion: 1,
        id: "ws-1",
        name: "Kelajak Merosi",
        locale: "uz",
        glitchtip: GLITCHTIP,
        relay: null,
        telegram: null,
        applications: [],
        onboarding: { completedAt: null, currentStage: 1 },
      });
    });
  });

  describe("loadWorkspace / saveWorkspace", () => {
    it("loadWorkspace returns null when nothing is stored", async () => {
      getMock.mockResolvedValue(undefined);
      await expect(loadWorkspace()).resolves.toBeNull();
      expect(getMock).toHaveBeenCalledWith("workspace");
    });

    it("round-trips a saved workspace through the mocked LazyStore", async () => {
      let persisted: unknown;
      setMock.mockImplementation(async (_key: string, value: unknown) => {
        persisted = value;
      });
      getMock.mockImplementation(async () => persisted);

      const workspace = createWorkspace({ id: "ws-1", name: "Kelajak Merosi", glitchtip: GLITCHTIP });

      await saveWorkspace(workspace);
      expect(setMock).toHaveBeenCalledWith("workspace", workspace);
      expect(saveMock).toHaveBeenCalledTimes(1);

      await expect(loadWorkspace()).resolves.toEqual(workspace);
    });

    it("saveWorkspace validates before writing: nothing is persisted on a rejection", async () => {
      const invalid = { ...createWorkspace({ id: "ws-1", name: "n", glitchtip: GLITCHTIP }), schemaVersion: 2 };
      // @ts-expect-error - deliberately invalid schemaVersion for the test
      await expect(saveWorkspace(invalid)).rejects.toThrow(/schemaVersion/);
      expect(setMock).not.toHaveBeenCalled();
      expect(saveMock).not.toHaveBeenCalled();
    });

    it("migrates data read back from disk (e.g. defaults a field an older write omitted)", async () => {
      getMock.mockResolvedValue(minimalRaw());
      const result = await loadWorkspace();
      expect(result?.locale).toBe("uz");
      expect(result?.applications).toEqual([]);
    });
  });
});

describe("first-run workspace", () => {
  it("starts a draft at stage 1 that cannot be saved before GlitchTip is verified", () => {
    const draft = draftWorkspace("default", "ru");
    expect(draft.locale).toBe("ru");
    expect(draft.onboarding).toEqual({ completedAt: null, currentStage: 1 });
    expect(() => migrateWorkspace(draft)).toThrow();
  });

  it("picks the first supported system language, Uzbek otherwise", () => {
    expect(preferredLocale(["de-DE", "ru-RU", "en"])).toBe("ru");
    expect(preferredLocale(["en-GB"])).toBe("en");
    expect(preferredLocale(["uz-Latn-UZ"])).toBe("uz");
    expect(preferredLocale(["fr-FR"])).toBe("uz");
    expect(preferredLocale([])).toBe("uz");
  });
});
