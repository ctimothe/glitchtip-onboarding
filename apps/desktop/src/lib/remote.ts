// Typed IPC wrappers for the SSH deployment commands in src-tauri/src/remote.rs.
//
// Invoke-only: no screen calls `invoke` directly. Rust validates every field
// again and returns a bare error code string on failure, which becomes the
// `Error` message here. No token ever travels through these types; Rust reads
// workspace secrets from the Keychain itself.

import { invoke } from "@tauri-apps/api/core";

import type { RelayDeployment } from "../app/workspace";

export type ServerRequest = {
  host: string;
  user: string;
  port: number;
  identityFile: string;
  dockerNetwork: string;
  deploymentDir: string;
};
export type DeployRequest = ServerRequest & { workspaceId: string; applicationIds: string[] };

/**
 * The release to roll back to after a successful deploy. A new release makes
 * the one running before it the target; reconfiguring the running release
 * keeps the target. When the server already ran the new release (a retry
 * after a stage failed past its deploy), the release the workspace last knew
 * is the target.
 */
export function rollbackTarget(
  relay: Pick<RelayDeployment, "revision" | "previousRevision">,
  result: Pick<DeploymentResult, "revision" | "previousRevision">,
): string | null {
  if (result.previousRevision !== null && result.previousRevision !== result.revision) return result.previousRevision;
  return relay.revision !== result.revision ? relay.revision : relay.previousRevision;
}

/** How to reach the deployed relay, with the key path chosen at setup. */
export function serverRequestFor(relay: RelayDeployment): ServerRequest {
  return {
    host: relay.host,
    user: relay.user,
    port: relay.port,
    identityFile: relay.identityFile,
    dockerNetwork: relay.dockerNetwork,
    deploymentDir: relay.deploymentDir,
  };
}
export type ServerPreflight = {
  ok: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  existingRevision: string | null;
};
export type DeploymentPreview = {
  revision: string;
  previousRevision: string | null;
  files: Array<{ path: string; mode: "0600" | "0644" }>;
  composeServices: string[];
  publishedPorts: number[];
  commands: string[];
};
export type DeploymentResult = {
  ok: boolean;
  revision: string;
  previousRevision: string | null;
  failedStep: string | null;
};
export type RelayStatus = { reachable: boolean; healthy: boolean; revision: string | null; detail: string };
export type AuditRecord = Record<string, string | number | null>;
export type RelayCommand =
  | { kind: "pairing-create" }
  | { kind: "pairing-status" }
  | { kind: "topic-create"; name: string; color: number }
  | { kind: "send-test"; applicationId: string }
  | { kind: "send-setup-complete"; applicationId: string }
  | { kind: "audit-tail"; lines: number };

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw typeof err === "string" ? new Error(err) : err;
  }
}

export function serverPreflight(request: ServerRequest): Promise<ServerPreflight> {
  return call("server_preflight", { request });
}

export function deploymentPreview(request: DeployRequest): Promise<DeploymentPreview> {
  return call("deployment_preview", { request });
}

export function deployRelay(request: DeployRequest): Promise<DeploymentResult> {
  return call("deploy_relay", { request });
}

export function relayStatus(request: ServerRequest): Promise<RelayStatus> {
  return call("relay_status", { request });
}

export function relayAuditTail(request: ServerRequest & { lines: number }): Promise<AuditRecord[]> {
  return call("relay_audit_tail", { request });
}

export function rollbackRelay(request: ServerRequest & { toRevision: string }): Promise<DeploymentResult> {
  return call("rollback_relay", { request });
}

export function relayControl(request: ServerRequest, command: RelayCommand): Promise<unknown> {
  return call("relay_control", { request, command });
}
