import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  deployRelay,
  deploymentPreview,
  relayAuditTail,
  relayControl,
  relayStatus,
  rollbackRelay,
  rollbackTarget,
  serverPreflight,
  type DeployRequest,
  type ServerRequest,
} from "./remote";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const server: ServerRequest = {
  host: "host.example",
  user: "ops",
  port: 22,
  identityFile: "/Users/me/.ssh/id_ed25519",
  dockerNetwork: "glitchtip",
  deploymentDir: "/home/ops/.local/share/glitchtip-companion",
};
const deploy: DeployRequest = { ...server, workspaceId: "acme", applicationIds: ["app-1"] };

beforeEach(() => vi.clearAllMocks());

describe("rollback target after a deploy", () => {
  const relay = { revision: "r1", previousRevision: "r0" };

  it("is the release that was running before a new one", () => {
    expect(rollbackTarget(relay, { revision: "r2", previousRevision: "r1" })).toBe("r1");
  });

  it("stays put when the running release is only reconfigured", () => {
    expect(rollbackTarget(relay, { revision: "r1", previousRevision: "r1" })).toBe("r0");
  });

  it("is the release the workspace last knew when a retry finds the new one already running", () => {
    expect(rollbackTarget(relay, { revision: "r2", previousRevision: "r2" })).toBe("r1");
  });
});

describe("remote wrappers", () => {
  it.each([
    ["server_preflight", () => serverPreflight(server), { request: server }],
    ["deployment_preview", () => deploymentPreview(deploy), { request: deploy }],
    ["deploy_relay", () => deployRelay(deploy), { request: deploy }],
    ["relay_status", () => relayStatus(server), { request: server }],
  ])("%s passes { request }", async (name, run, args) => {
    invokeMock.mockResolvedValueOnce({});
    await run();
    expect(invokeMock).toHaveBeenCalledWith(name, args);
  });

  it("relay_audit_tail passes the lines", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const request = { ...server, lines: 20 };
    await relayAuditTail(request);
    expect(invokeMock).toHaveBeenCalledWith("relay_audit_tail", { request });
  });

  it("rollback_relay passes the target revision", async () => {
    invokeMock.mockResolvedValueOnce({});
    const request = { ...server, toRevision: "abc123" };
    await rollbackRelay(request);
    expect(invokeMock).toHaveBeenCalledWith("rollback_relay", { request });
  });

  it("relay_control passes request and command", async () => {
    invokeMock.mockResolvedValueOnce({ topicId: 3 });
    const command = { kind: "topic-create", name: "Alerts", color: 7322096 } as const;
    await expect(relayControl(server, command)).resolves.toEqual({ topicId: 3 });
    expect(invokeMock).toHaveBeenCalledWith("relay_control", { request: server, command });
  });

  it("turns a rejected error code into an Error", async () => {
    invokeMock.mockRejectedValueOnce("invalid-host");
    await expect(relayStatus(server)).rejects.toThrow("invalid-host");
  });
});
