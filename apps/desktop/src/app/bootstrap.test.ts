import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { bootstrap } from "./bootstrap";
import { get, LEGACY_WORKSPACE_ID } from "../lib/secrets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

// Stands in for the first screen: it reads a secret as soon as it mounts.
function firstScreen() {
  void get(LEGACY_WORKSPACE_ID, "glitchtip.url");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("secrets startup migration (bootstrap)", () => {
  it("migrates the legacy vault before rendering, so it precedes the first secret read", async () => {
    let finish: (value: unknown) => void = () => {};
    invokeMock.mockImplementation((command) =>
      command === "secret_migrate_file_vault"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(null),
    );
    const render = vi.fn(firstScreen);

    const started = bootstrap(render);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Still waiting on the migration: nothing rendered, nothing read.
    expect(render).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "secret_migrate_file_vault",
    ]);

    finish({ migrated: ["glitchtip.url"], verified: [], conflicts: [] });
    await started;

    expect(render).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls).toEqual([
      ["secret_migrate_file_vault", { workspaceId: "default" }],
      ["secret_get", { workspaceId: "default", key: "glitchtip.url" }],
    ]);
  });

  it("still renders when the migration fails and warns with the code only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce("keychain-locked");
    const render = vi.fn();

    await bootstrap(render);

    expect(render).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("file vault migration failed:", "keychain-locked");
  });

  it("never logs text that is not a known code", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(new Error("token=canary-secret"));
    const render = vi.fn();

    await bootstrap(render);

    expect(render).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("file vault migration failed:", "unknown");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("canary-secret");
  });

  it("stays silent on success and never deletes the file vault", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockResolvedValueOnce({ migrated: [], verified: [], conflicts: [] });

    await bootstrap(vi.fn());

    expect(warn).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "secret_migrate_file_vault",
    ]);
  });
});
