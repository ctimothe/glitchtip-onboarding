// Typed IPC wrapper for the Keychain commands in src-tauri/src/keychain.rs.
//
// Secrets live in the macOS Keychain under the service
// `dev.ctimothe.glitchtip-companion`, one item per `<workspaceId>/<key>`.
// Rust owns every Keychain call; this module validates identifiers early (the
// same rules Rust enforces again) and turns a rejected command's error code
// into an `Error` whose message is that code. Error codes never carry a
// secret value.

import { invoke } from "@tauri-apps/api/core";

// Every code a Keychain command can return. Must match `SecretError::code`
// in keychain.rs.
export const SECRET_ERROR_CODES = [
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
] as const;

export type SecretErrorCode = (typeof SECRET_ERROR_CODES)[number];

export function isSecretErrorCode(value: string): value is SecretErrorCode {
  return (SECRET_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Result of copying the old `secrets.json` file vault into the Keychain. Key
 * names only: `migrated` were absent and are now written and read back,
 * `verified` already held the same value, `conflicts` hold a different value
 * that was kept.
 */
export type MigrationResult = {
  migrated: string[];
  verified: string[];
  conflicts: string[];
};

/** Result of deleting the old `secrets.json` file vault. */
export type RemovalResult = { removed: boolean };

// Must match `valid_workspace_id` and `valid_key` in keychain.rs. Keys allow
// upper case after the first character only for the camelCase v1 vault keys
// (`telegram.botToken`, `telegram.chatId`, `telegram.chatTitle`).
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_KEY_PATTERN = /^[a-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value);
}

export function isSecretKey(value: string): boolean {
  return SECRET_KEY_PATTERN.test(value);
}

function requireWorkspaceId(workspaceId: string): void {
  if (!isWorkspaceId(workspaceId)) {
    throw new Error("invalid-workspace-id" satisfies SecretErrorCode);
  }
}

function requireKey(key: string): void {
  if (!isSecretKey(key)) {
    throw new Error("invalid-secret-key" satisfies SecretErrorCode);
  }
}

// Tauri rejects with the command's `Err` value, which for these commands is
// a bare code string.
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw typeof err === "string" ? new Error(err) : err;
  }
}

export async function secretGet(workspaceId: string, key: string): Promise<string | null> {
  requireWorkspaceId(workspaceId);
  requireKey(key);
  return call<string | null>("secret_get", { workspaceId, key });
}

export async function secretSet(workspaceId: string, key: string, value: string): Promise<void> {
  requireWorkspaceId(workspaceId);
  requireKey(key);
  await call<null>("secret_set", { workspaceId, key, value });
}

export async function secretRemove(workspaceId: string, key: string): Promise<void> {
  requireWorkspaceId(workspaceId);
  requireKey(key);
  await call<null>("secret_remove", { workspaceId, key });
}

/** Names of the keys stored for a workspace. Never returns values. */
export async function secretPresence(workspaceId: string): Promise<string[]> {
  requireWorkspaceId(workspaceId);
  return call<string[]>("secret_presence", { workspaceId });
}

/**
 * Copy every entry of the v1 `secrets.json` vault into the workspace and read
 * each written key back. Existing Keychain items are never overwritten. The
 * file is never deleted here (see `removeFileVault`), so this is safe to run
 * on every start. A missing file is an empty result.
 */
export async function migrateFileVault(workspaceId: string): Promise<MigrationResult> {
  requireWorkspaceId(workspaceId);
  return call<MigrationResult>("secret_migrate_file_vault", { workspaceId });
}

/**
 * Delete the v1 `secrets.json` vault, only once every one of its keys reads
 * back from the workspace with an equal value. Rejects with
 * `vault-not-verified` or `vault-remove-failed` and keeps the file
 * otherwise. A missing file resolves `{ removed: false }`.
 */
export async function removeFileVault(workspaceId: string): Promise<RemovalResult> {
  requireWorkspaceId(workspaceId);
  return call<RemovalResult>("secret_remove_file_vault", { workspaceId });
}
