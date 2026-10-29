// Secret storage (tokens, DSNs, chat bindings), backed by the macOS Keychain.
//
// A compatibility wrapper that keeps the old `get` / `set` / `remove` names
// but now requires a workspace ID. The Keychain work happens in Rust
// (src-tauri/src/keychain.rs) behind the typed wrappers in ./keychain; this
// module never touches the filesystem or the Tauri Store.
//
// The old JSON file vault (`$APPCONFIG/secrets.json`) is no longer read or
// written here. `bootstrap()` (src/app/bootstrap.ts) copies its entries into
// the Keychain at startup with `migrateFileVault`; deleting the file is a
// separate, verified step (`removeFileVault` in ./keychain).

import { secretGet, secretRemove, secretSet } from "./keychain";

/**
 * Workspace ID for the v1 wizard screens and the relay daemon, which predate
 * workspaces. New code passes the real workspace ID instead.
 */
export const LEGACY_WORKSPACE_ID = "default";

export function get(workspaceId: string, key: string): Promise<string | null> {
  return secretGet(workspaceId, key);
}

export function set(workspaceId: string, key: string, value: string): Promise<void> {
  return secretSet(workspaceId, key, value);
}

export function remove(workspaceId: string, key: string): Promise<void> {
  return secretRemove(workspaceId, key);
}
