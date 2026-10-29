// App startup, run by main.tsx before the first render.
//
// Copies the v1 `secrets.json` file vault into the Keychain for the legacy
// workspace before any screen can read a secret, so saved credentials show
// up on the first screen. The migration never deletes the file and never
// overwrites an existing Keychain item, so running it on every start is
// safe. A failure is logged as a bare error code and the app renders anyway.

import { isSecretErrorCode, migrateFileVault } from "../lib/keychain";
import { LEGACY_WORKSPACE_ID } from "../lib/secrets";

export async function bootstrap(render: () => void): Promise<void> {
  try {
    await migrateFileVault(LEGACY_WORKSPACE_ID);
  } catch (err) {
    const code = err instanceof Error && isSecretErrorCode(err.message) ? err.message : "unknown";
    console.warn("file vault migration failed:", code);
  }
  render();
}
