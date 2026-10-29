// Typed wrappers over the agent-install Tauri commands. Invoke-only: the
// Rust side owns file generation, diffing and verification.

import { invoke } from "@tauri-apps/api/core";

export type AgentProvider = "codex" | "claude" | "other";

export type AgentInstallRequest = {
  workspaceId: string;
  applicationId: string;
  repositoryPath: string;
  providers: AgentProvider[];
  /** Shown in the repository's `.glitchtip-companion.json`; the helper reads neither from there. */
  projectSlug?: string;
  glitchtipBaseUrl?: string;
};

export type AgentInstallPreview = {
  files: Array<{ path: string; action: "create" | "unchanged" | "update"; diff?: string }>;
  helperPath: string;
  requiresConfirmation: boolean;
};

export type AgentInstallResult = {
  installed: string[];
  unchanged: string[];
  helperInstalled: boolean;
};

export type AgentVerifyResult = {
  ok: boolean;
  failedStep: string | null;
  canaryFound: boolean;
  incidentRef: string;
};

// Rust fails with a bare code string; it becomes the Error's message.
async function call<T>(command: string, request: AgentInstallRequest): Promise<T> {
  try {
    return await invoke<T>(command, { request });
  } catch (err) {
    throw typeof err === "string" ? new Error(err) : err;
  }
}

export function agentInstallPreview(request: AgentInstallRequest): Promise<AgentInstallPreview> {
  return call("agent_install_preview", request);
}

export function agentInstall(request: AgentInstallRequest): Promise<AgentInstallResult> {
  return call("agent_install", request);
}

export function agentVerify(request: AgentInstallRequest): Promise<AgentVerifyResult> {
  return call("agent_verify", request);
}
