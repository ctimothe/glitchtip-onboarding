import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { agentInstall, agentInstallPreview, agentVerify, type AgentInstallRequest } from "./agent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const request: AgentInstallRequest = {
  workspaceId: "ws-1",
  applicationId: "app-1",
  repositoryPath: "/repo",
  providers: ["codex", "claude"],
};

beforeEach(() => invokeMock.mockReset());

describe("agent wrappers", () => {
  it.each([
    ["agent_install_preview", agentInstallPreview],
    ["agent_install", agentInstall],
    ["agent_verify", agentVerify],
  ] as const)("%s passes { request } to the Tauri command", async (command, fn) => {
    invokeMock.mockResolvedValueOnce({ ok: true });
    await expect(fn(request)).resolves.toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledWith(command, { request });
  });
});
