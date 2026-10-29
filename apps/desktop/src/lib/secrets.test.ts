import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { get, LEGACY_WORKSPACE_ID, remove, set } from "./secrets";
import {
  isSecretErrorCode,
  isSecretKey,
  isWorkspaceId,
  migrateFileVault,
  removeFileVault,
  secretPresence,
} from "./keychain";
import secretsSource from "./secrets.ts?raw";
import keychainSource from "./keychain.ts?raw";

// Records whether either file-backed plugin is ever imported. vi.mock
// factories run only when the module is actually loaded, so a flag still
// false after exercising every method proves the wrappers never touch them.
const loaded = vi.hoisted(() => ({ fs: false, store: false }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => {
  loaded.fs = true;
  return { writeTextFile: vi.fn(), readTextFile: vi.fn(), exists: vi.fn(), mkdir: vi.fn() };
});
vi.mock("@tauri-apps/plugin-store", () => {
  loaded.store = true;
  return { LazyStore: vi.fn(), Store: vi.fn(), load: vi.fn() };
});

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("secrets keychain wrapper", () => {
  it("get invokes secret_get with the workspace ID and key", async () => {
    invokeMock.mockResolvedValueOnce("tok-1");

    await expect(get("acme", "glitchtip.token")).resolves.toBe("tok-1");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("secret_get", {
      workspaceId: "acme",
      key: "glitchtip.token",
    });
  });

  it("get returns null for a secret that is not stored", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(get("acme", "glitchtip.url")).resolves.toBeNull();
  });

  it("set invokes secret_set and sends the value only as its value arg", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await set("acme", "telegram.botToken", "canary-bot-token");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("secret_set", {
      workspaceId: "acme",
      key: "telegram.botToken",
      value: "canary-bot-token",
    });
  });

  it("set accepts an empty value", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await set("acme", "glitchtip.team", "");

    expect(invokeMock).toHaveBeenCalledWith("secret_set", {
      workspaceId: "acme",
      key: "glitchtip.team",
      value: "",
    });
  });

  it("remove invokes secret_remove with the workspace ID and key", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await remove("acme", "glitchtip.token");

    expect(invokeMock).toHaveBeenCalledWith("secret_remove", {
      workspaceId: "acme",
      key: "glitchtip.token",
    });
  });

  it("legacy callers share the explicit default workspace", () => {
    expect(LEGACY_WORKSPACE_ID).toBe("default");
    expect(isWorkspaceId(LEGACY_WORKSPACE_ID)).toBe(true);
  });

  it("rejects a bad workspace ID or key before any IPC", async () => {
    await expect(get("../acme", "glitchtip.token")).rejects.toThrow("invalid-workspace-id");
    await expect(set("Acme", "glitchtip.token", "v")).rejects.toThrow("invalid-workspace-id");
    await expect(set("acme", "telegram\nbot", "v")).rejects.toThrow("invalid-secret-key");
    await expect(remove("acme", "a/b")).rejects.toThrow("invalid-secret-key");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("turns a rejected command code into an Error with that code", async () => {
    invokeMock.mockRejectedValueOnce("keychain-locked");
    await expect(get("acme", "glitchtip.token")).rejects.toThrow(new Error("keychain-locked"));

    invokeMock.mockRejectedValueOnce("keychain-write-failed");
    const failure = await set("acme", "glitchtip.token", "canary-token").catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("keychain-write-failed");
    expect(String(failure)).not.toContain("canary-token");
  });

  it("never loads the fs or store plugins, so no secret reaches a file or the Store", async () => {
    invokeMock.mockResolvedValue(null);

    await set("acme", "glitchtip.token", "canary-token");
    await get("acme", "glitchtip.token");
    await remove("acme", "glitchtip.token");
    invokeMock.mockResolvedValueOnce([]);
    await secretPresence("acme");
    invokeMock.mockResolvedValueOnce({ migrated: [], verified: [], conflicts: [] });
    await migrateFileVault("acme");
    invokeMock.mockResolvedValueOnce({ removed: false });
    await removeFileVault("acme");

    expect(loaded.fs).toBe(false);
    expect(loaded.store).toBe(false);
    for (const source of [secretsSource, keychainSource]) {
      expect(source).not.toMatch(/plugin-fs|plugin-store/);
    }
    // The canary crossed IPC exactly once, as secret_set's value.
    const carriers = invokeMock.mock.calls.filter(([, args]) =>
      JSON.stringify(args ?? null).includes("canary-token"),
    );
    expect(carriers).toEqual([
      ["secret_set", { workspaceId: "acme", key: "glitchtip.token", value: "canary-token" }],
    ]);
  });
});

describe("secrets keychain IPC", () => {
  it("presence invokes secret_presence and returns key names", async () => {
    invokeMock.mockResolvedValueOnce(["glitchtip.token", "telegram.botToken"]);

    await expect(secretPresence("acme")).resolves.toEqual([
      "glitchtip.token",
      "telegram.botToken",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("secret_presence", { workspaceId: "acme" });
  });

  it("migrateFileVault invokes secret_migrate_file_vault and returns key names only", async () => {
    const result = {
      migrated: ["glitchtip.url"],
      verified: ["glitchtip.token"],
      conflicts: ["telegram.botToken"],
    };
    invokeMock.mockResolvedValueOnce(result);

    await expect(migrateFileVault("default")).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledWith("secret_migrate_file_vault", {
      workspaceId: "default",
    });
  });

  it("migrateFileVault surfaces vault codes as Errors", async () => {
    invokeMock.mockRejectedValueOnce("vault-corrupt");

    await expect(migrateFileVault("default")).rejects.toThrow(new Error("vault-corrupt"));
  });

  it("removeFileVault invokes secret_remove_file_vault", async () => {
    invokeMock.mockResolvedValueOnce({ removed: true });

    await expect(removeFileVault("default")).resolves.toEqual({ removed: true });
    expect(invokeMock).toHaveBeenCalledWith("secret_remove_file_vault", {
      workspaceId: "default",
    });
  });

  it("removeFileVault surfaces a refusal as an Error with its code", async () => {
    invokeMock.mockRejectedValueOnce("vault-not-verified");
    await expect(removeFileVault("default")).rejects.toThrow(new Error("vault-not-verified"));

    invokeMock.mockRejectedValueOnce("vault-remove-failed");
    await expect(removeFileVault("default")).rejects.toThrow(new Error("vault-remove-failed"));
  });

  it("presence, migration and removal validate the workspace ID before IPC", async () => {
    await expect(secretPresence("acme/x")).rejects.toThrow("invalid-workspace-id");
    await expect(migrateFileVault("")).rejects.toThrow("invalid-workspace-id");
    await expect(removeFileVault("../default")).rejects.toThrow("invalid-workspace-id");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("recognises exactly the codes keychain.rs returns", () => {
    for (const code of [
      "invalid-workspace-id",
      "invalid-secret-key",
      "keychain-denied",
      "keychain-locked",
      "secret-not-found",
      "keychain-write-failed",
      "vault-corrupt",
      "vault-unreadable",
      "vault-not-verified",
      "vault-remove-failed",
    ]) {
      expect(isSecretErrorCode(code), code).toBe(true);
    }
    expect(isSecretErrorCode("token=abc")).toBe(false);
    expect(isSecretErrorCode("")).toBe(false);
  });

  it("identifier rules mirror keychain.rs", () => {
    expect(isWorkspaceId("a".repeat(63))).toBe(true);
    expect(isWorkspaceId("0-team-9")).toBe(true);
    for (const bad of ["", "-acme", "Acme", "acme/x", "acme.x", "acme_x", "acme\n", "acmé", "a".repeat(64)]) {
      expect(isWorkspaceId(bad), JSON.stringify(bad)).toBe(false);
    }

    expect(isSecretKey(`k${"x".repeat(127)}`)).toBe(true);
    for (const key of [
      "glitchtip.url",
      "glitchtip.token",
      "glitchtip.org",
      "glitchtip.team",
      "glitchtip.project",
      "telegram.botToken",
      "telegram.chatId",
      "telegram.chatTitle",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const bad of [
      "",
      ".hidden",
      "-dash",
      "_under",
      "Upper",
      "a/b",
      "a b",
      "a\tb",
      "a\u0000b",
      "glitchtip.token\n",
      "ключ",
      `k${"x".repeat(128)}`,
    ]) {
      expect(isSecretKey(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
