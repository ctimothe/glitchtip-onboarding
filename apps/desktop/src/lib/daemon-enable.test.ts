// Enable-path assembly tests: the frontend's half of the env-preservation
// contract (vault re-sync + explicit-patch-last, never displayed values).
// Raw preservation itself lives in Rust (`merge_enable_env`, tested there)
// because only the file has the raw secrets; these tests pin what the
// frontend sends to `daemon_set_enabled` (env record + RunAtLoad flag —
// finished XML never crosses IPC; the full plist is built by Rust
// `build_plist`).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  getBootOnLogin,
  getDaemonStatusDetail,
  REDACTED_ENV_VALUE,
  setDaemonEnabled,
} from "./daemon";
import { get as getSecret } from "./secrets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./secrets", () => ({ get: vi.fn(), LEGACY_WORKSPACE_ID: "default" }));

const invokeMock = vi.mocked(invoke);
const getSecretMock = vi.mocked(getSecret);

const VAULT: Record<string, string> = {
  "telegram.botToken": "bot-fresh",
  "telegram.chatId": "chat-1",
  "glitchtip.url": "https://glitchtip.example.com",
  "glitchtip.token": "tok-fresh",
  "glitchtip.project": "proj",
};

function mockSecrets() {
  getSecretMock.mockImplementation(async (workspaceId: string, key: string) =>
    workspaceId === "default" ? (VAULT[key] ?? null) : null,
  );
}

function sentEnableArgs(): { enabled: boolean; env: Record<string, string>; runAtLoad: boolean } {
  const enableCall = invokeMock.mock.calls.find(([cmd]) => cmd === "daemon_set_enabled");
  expect(enableCall).toBeDefined();
  const args = enableCall![1] as { enabled: boolean; env: Record<string, string>; runAtLoad: boolean };
  expect(args.enabled).toBe(true);
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setDaemonEnabled env assembly", () => {
  it("re-syncs vault values without reading displayed (redacted) env", async () => {
    mockSecrets();
    invokeMock.mockResolvedValueOnce("The relay is installed and running.");

    await setDaemonEnabled(true);

    // daemon_set_enabled only — no daemon_paths call and no finished XML,
    // so redacted display values can never feed a reinstall.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const args = sentEnableArgs();
    expect(args.env).toMatchObject({
      TELEGRAM_ALERT_BOT_TOKEN: "bot-fresh",
      GLITCHTIP_API_TOKEN: "tok-fresh",
    });
    expect(args.runAtLoad).toBe(false);
    // The relay is fed from the legacy workspace until workspaces replace it.
    expect(getSecretMock.mock.calls.length).toBeGreaterThan(0);
    for (const [workspaceId] of getSecretMock.mock.calls) {
      expect(workspaceId).toBe("default");
    }
  });

  it("sends no XML over IPC", async () => {
    mockSecrets();
    invokeMock.mockResolvedValueOnce("The relay is installed and running.");

    await setDaemonEnabled(true);

    const args = sentEnableArgs();
    expect(args).not.toHaveProperty("plistXml");
  });

  it("applies the explicit patch last so it wins over the vault", async () => {
    mockSecrets();
    invokeMock.mockResolvedValueOnce("The relay is installed and running.");

    await setDaemonEnabled(true, {
      GLITCHTIP_API_BASE: "https://override.example.com",
      PROJECT_APP_BASES: '{"b":2}',
    });

    const args = sentEnableArgs();
    expect(args.env.GLITCHTIP_API_BASE).toBe("https://override.example.com");
    expect(args.env.PROJECT_APP_BASES).toBe('{"b":2}');
  });

  it("strips redacted patch entries and passes empty values through as deletions", async () => {
    mockSecrets();
    invokeMock.mockResolvedValueOnce("The relay is installed and running.");

    await setDaemonEnabled(true, {
      GLITCHTIP_API_TOKEN: REDACTED_ENV_VALUE,
      LOG_PAYLOAD: "",
    });

    const args = sentEnableArgs();
    // Redacted = keep stored secret → omitted from the incoming env.
    expect(args.env.GLITCHTIP_API_TOKEN).toBe("tok-fresh");
    expect(Object.values(args.env)).not.toContain(REDACTED_ENV_VALUE);
    // Empty = delete marker for the Rust merge → passed through empty.
    expect(args.env.LOG_PAYLOAD).toBe("");
  });

  it("leaves PORT out when unpatched (Rust preserves or defaults it)", async () => {
    mockSecrets();
    invokeMock.mockResolvedValueOnce("The relay is installed and running.");

    await setDaemonEnabled(true);

    expect(sentEnableArgs().env).not.toHaveProperty("PORT");
  });

  it("disables with null env/runAtLoad", async () => {
    invokeMock.mockResolvedValueOnce("The relay is disabled.");

    await setDaemonEnabled(false);

    expect(invokeMock).toHaveBeenCalledWith("daemon_set_enabled", {
      enabled: false,
      env: null,
      runAtLoad: null,
    });
  });
});

describe("getBootOnLogin", () => {
  it("passes the installed RunAtLoad state through", async () => {
    invokeMock.mockResolvedValueOnce(true);

    await expect(getBootOnLogin()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("daemon_get_boot");
  });

  it("is false when nothing is installed", async () => {
    invokeMock.mockResolvedValueOnce(false);

    await expect(getBootOnLogin()).resolves.toBe(false);
  });
});

describe("getDaemonStatusDetail", () => {
  it("passes state + pid through", async () => {
    invokeMock.mockResolvedValueOnce({ state: "running", pid: 4242 });

    await expect(getDaemonStatusDetail()).resolves.toEqual({ state: "running", pid: 4242 });
    expect(invokeMock).toHaveBeenCalledWith("daemon_status_detail");
  });

  it("throws on an unknown state", async () => {
    invokeMock.mockResolvedValueOnce({ state: "bogus", pid: null });

    await expect(getDaemonStatusDetail()).rejects.toThrow("unknown status");
  });
});
