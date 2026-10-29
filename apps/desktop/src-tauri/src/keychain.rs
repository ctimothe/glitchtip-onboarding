// Workspace secrets in the macOS Keychain.
//
// Every secret is a generic-password item under one service,
// `dev.ctimothe.glitchtip-companion`, with the account name
// `<workspace_id>/<key>`. Both halves are validated before any Keychain call,
// so a path-like, multi-line or otherwise odd identifier never reaches
// Security.framework.
//
// Items live in the login keychain (not the data-protection keychain, which
// needs a signed keychain-access-groups entitlement) and are never
// synchronised through iCloud.
//
// Secret values are never logged, formatted or put into an error. Every
// command returns `Err(code)` with one of the stable codes from
// `SecretError::code`, and nothing else.
//
// Keychain access sits behind `SecretStore` so the account-name, presence and
// migration logic is unit-tested against an in-memory fake; `MacKeychain` is
// the only implementation that touches the real Keychain.

use std::collections::BTreeSet;
use std::path::Path;

use tauri::Manager;

/// Keychain service shared by every Companion secret.
pub const SERVICE: &str = "dev.ctimothe.glitchtip-companion";

/// The v1 file vault, in the app config dir. Read only by the migration.
pub const VAULT_FILE: &str = "secrets.json";

/// Workspace ID the v1 wizard screens use until they are replaced. Must match
/// `LEGACY_WORKSPACE_ID` in `src/lib/secrets.ts`.
#[cfg_attr(not(test), allow(dead_code))]
pub const LEGACY_WORKSPACE_ID: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretError {
    InvalidWorkspaceId,
    InvalidKey,
    Denied,
    Locked,
    NotFound,
    WriteFailed,
    VaultCorrupt,
    VaultUnreadable,
    VaultNotVerified,
    VaultRemoveFailed,
}

impl SecretError {
    /// The only text that crosses IPC for a failure. Mirrored by
    /// `SecretErrorCode` in `src/lib/keychain.ts`.
    pub fn code(self) -> &'static str {
        match self {
            SecretError::InvalidWorkspaceId => "invalid-workspace-id",
            SecretError::InvalidKey => "invalid-secret-key",
            SecretError::Denied => "keychain-denied",
            SecretError::Locked => "keychain-locked",
            SecretError::NotFound => "secret-not-found",
            SecretError::WriteFailed => "keychain-write-failed",
            SecretError::VaultCorrupt => "vault-corrupt",
            SecretError::VaultUnreadable => "vault-unreadable",
            SecretError::VaultNotVerified => "vault-not-verified",
            SecretError::VaultRemoveFailed => "vault-remove-failed",
        }
    }
}

/// Whether a failed Keychain call was reading or mutating. Only decides the
/// fallback for statuses `map_status` does not recognise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// Map a Security.framework `OSStatus` to a user-safe error. Codes are from
/// `Security.framework/Headers/SecBase.h`.
pub fn map_status(status: i32, access: Access) -> SecretError {
    match status {
        // errSecItemNotFound
        -25300 => SecretError::NotFound,
        // errSecInteractionNotAllowed, errSecInteractionRequired,
        // errSecInDarkWake, errSecNotAvailable, errSecNoDefaultKeychain
        -25308 | -25315 | -25320 | -25291 | -25307 => SecretError::Locked,
        // errSecUserCanceled, errSecAuthFailed, errSecNoAccessForItem,
        // errSecInvalidOwnerEdit, errSecMissingEntitlement,
        // errSecRestrictedAPI, errSecWrPerm, errSecReadOnly
        -128 | -25293 | -25243 | -25244 | -34018 | -34020 | -61 | -25292 => SecretError::Denied,
        _ => match access {
            Access::Write => SecretError::WriteFailed,
            Access::Read => SecretError::Denied,
        },
    }
}

/// `^[a-z0-9][a-z0-9-]{0,62}$`
fn valid_workspace_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    match bytes.first() {
        Some(b) if b.is_ascii_lowercase() || b.is_ascii_digit() => {}
        _ => return false,
    }
    bytes.len() <= 63
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `^[a-z0-9][A-Za-z0-9._-]{0,127}$` — upper case is allowed after the first
/// character only because the v1 vault keys `telegram.botToken`,
/// `telegram.chatId` and `telegram.chatTitle` are camelCase and are kept.
fn valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    match bytes.first() {
        Some(b) if b.is_ascii_lowercase() || b.is_ascii_digit() => {}
        _ => return false,
    }
    bytes.len() <= 128
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Keychain account name for one secret: `<workspace_id>/<key>`.
pub fn account_name(workspace_id: &str, key: &str) -> Result<String, SecretError> {
    if !valid_workspace_id(workspace_id) {
        return Err(SecretError::InvalidWorkspaceId);
    }
    if !valid_key(key) {
        return Err(SecretError::InvalidKey);
    }
    Ok(format!("{workspace_id}/{key}"))
}

/// Minimal Keychain surface, addressed by full account name under one
/// service. Implemented by `MacKeychain` and, in tests, an in-memory fake.
pub trait SecretStore {
    /// Create the item, or replace the value of an existing one.
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError>;
    /// `None` when no item exists.
    fn get(&self, account: &str) -> Result<Option<String>, SecretError>;
    /// Succeeds when no item exists.
    fn remove(&self, account: &str) -> Result<(), SecretError>;
    /// Every account name under the service, from attributes only. Must never
    /// load password data.
    fn accounts(&self) -> Result<Vec<String>, SecretError>;
}

pub fn set_secret(
    store: &dyn SecretStore,
    workspace_id: &str,
    key: &str,
    value: &str,
) -> Result<(), SecretError> {
    store.set(&account_name(workspace_id, key)?, value)
}

pub fn get_secret(
    store: &dyn SecretStore,
    workspace_id: &str,
    key: &str,
) -> Result<Option<String>, SecretError> {
    store.get(&account_name(workspace_id, key)?)
}

pub fn remove_secret(store: &dyn SecretStore, workspace_id: &str, key: &str) -> Result<(), SecretError> {
    store.remove(&account_name(workspace_id, key)?)
}

/// Sorted key names stored for one workspace. Accounts that do not parse as
/// `<workspace_id>/<valid key>` are ignored.
pub fn secret_presence_in(store: &dyn SecretStore, workspace_id: &str) -> Result<Vec<String>, SecretError> {
    if !valid_workspace_id(workspace_id) {
        return Err(SecretError::InvalidWorkspaceId);
    }
    let prefix = format!("{workspace_id}/");
    let keys: BTreeSet<String> = store
        .accounts()?
        .into_iter()
        .filter_map(|account| account.strip_prefix(&prefix).map(str::to_string))
        .filter(|key| valid_key(key))
        .collect();
    Ok(keys.into_iter().collect())
}

/// Outcome of copying the v1 file vault into the Keychain. Key names only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct MigrationResult {
    /// Absent from the Keychain; written, then read back equal.
    pub migrated: Vec<String>,
    /// Already in the Keychain with the same value as the file.
    pub verified: Vec<String>,
    /// Already in the Keychain with a different value. The Keychain value is
    /// kept and the file value is not written.
    pub conflicts: Vec<String>,
}

/// Outcome of deleting the v1 file vault.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RemovalResult {
    /// The file existed and was deleted.
    pub removed: bool,
}

/// Copy every entry of the v1 file vault at `path` into `workspace_id`.
/// Never deletes the file; `remove_file_vault` does that as its own step.
///
/// Order: validate the whole file, read every key from the Keychain, write
/// the keys that are absent, then read those back and compare. An existing
/// item is never overwritten: equal counts as `verified`, different as a
/// `conflict`. If a write or a read-back fails, the items written in this
/// run are removed again (best effort) and the error is returned, so a retry
/// starts from the same state instead of skipping a half-written key.
///
/// A missing file is an empty result. A file that is not a JSON object of
/// valid-key → string entries is `VaultCorrupt`; one that cannot be read is
/// `VaultUnreadable`. The file is never modified.
pub fn migrate_file_vault(
    store: &dyn SecretStore,
    workspace_id: &str,
    path: &Path,
) -> Result<MigrationResult, SecretError> {
    if !valid_workspace_id(workspace_id) {
        return Err(SecretError::InvalidWorkspaceId);
    }
    let entries = match read_vault(path)? {
        Some(entries) => entries,
        None => return Ok(MigrationResult { migrated: vec![], verified: vec![], conflicts: vec![] }),
    };

    let mut missing: Vec<(&str, String, &str)> = Vec::new();
    let mut verified = Vec::new();
    let mut conflicts = Vec::new();
    for (key, value) in &entries {
        let account = account_name(workspace_id, key)?;
        match store.get(&account)? {
            None => missing.push((key.as_str(), account, value.as_str())),
            Some(existing) if existing == *value => verified.push(key.clone()),
            Some(_) => conflicts.push(key.clone()),
        }
    }

    let mut attempted: Vec<&str> = Vec::new();
    if let Err(err) = write_and_verify(store, &missing, &mut attempted) {
        for account in attempted {
            let _ = store.remove(account);
        }
        return Err(err);
    }

    let migrated = missing.iter().map(|(key, _, _)| (*key).to_string()).collect();
    Ok(MigrationResult { migrated, verified, conflicts })
}

/// Write every `(key, account, value)` and read each one back. `attempted`
/// collects every account a write was tried for, so the caller can roll
/// back after a failure.
fn write_and_verify<'a>(
    store: &dyn SecretStore,
    missing: &'a [(&str, String, &str)],
    attempted: &mut Vec<&'a str>,
) -> Result<(), SecretError> {
    for (_, account, value) in missing {
        attempted.push(account.as_str());
        store.set(account, value)?;
    }
    for (_, account, value) in missing {
        if store.get(account)?.as_deref() != Some(*value) {
            return Err(SecretError::WriteFailed);
        }
    }
    Ok(())
}

/// Delete the v1 file vault at `path`, but only when every one of its keys
/// reads back from `workspace_id` in the Keychain with an equal value. Any
/// missing or different key is `VaultNotVerified`; a failed unlink is
/// `VaultRemoveFailed`. Both keep the file. A missing file is
/// `removed: false`.
pub fn remove_file_vault(
    store: &dyn SecretStore,
    workspace_id: &str,
    path: &Path,
) -> Result<RemovalResult, SecretError> {
    remove_file_vault_with(store, workspace_id, path, |path| std::fs::remove_file(path))
}

fn remove_file_vault_with(
    store: &dyn SecretStore,
    workspace_id: &str,
    path: &Path,
    unlink: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<RemovalResult, SecretError> {
    if !valid_workspace_id(workspace_id) {
        return Err(SecretError::InvalidWorkspaceId);
    }
    let entries = match read_vault(path)? {
        Some(entries) => entries,
        None => return Ok(RemovalResult { removed: false }),
    };
    for (key, value) in &entries {
        if store.get(&account_name(workspace_id, key)?)?.as_deref() != Some(value.as_str()) {
            return Err(SecretError::VaultNotVerified);
        }
    }
    unlink(path).map_err(|_| SecretError::VaultRemoveFailed)?;
    Ok(RemovalResult { removed: true })
}

/// The vault's entries, or `None` when the file does not exist.
fn read_vault(path: &Path) -> Result<Option<Vec<(String, String)>>, SecretError> {
    match std::fs::read(path) {
        Ok(bytes) => parse_vault(&bytes).map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(SecretError::VaultUnreadable),
    }
}

/// Parse the v1 vault into (key, value) pairs sorted by key.
fn parse_vault(bytes: &[u8]) -> Result<Vec<(String, String)>, SecretError> {
    let parsed: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| SecretError::VaultCorrupt)?;
    let object = match parsed {
        serde_json::Value::Object(object) => object,
        _ => return Err(SecretError::VaultCorrupt),
    };
    let mut entries = Vec::with_capacity(object.len());
    for (key, value) in object {
        match value {
            serde_json::Value::String(value) if valid_key(&key) => entries.push((key, value)),
            _ => return Err(SecretError::VaultCorrupt),
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

// --- Real Keychain -----------------------------------------------------------

#[cfg(target_os = "macos")]
pub struct MacKeychain {
    service: String,
}

#[cfg(target_os = "macos")]
impl MacKeychain {
    pub fn new(service: &str) -> Self {
        MacKeychain { service: service.to_string() }
    }

    fn options(&self, account: &str) -> security_framework::passwords::PasswordOptions {
        security_framework::passwords::PasswordOptions::new_generic_password(&self.service, account)
    }
}

#[cfg(target_os = "macos")]
impl SecretStore for MacKeychain {
    fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        security_framework::passwords::set_generic_password_options(value.as_bytes(), self.options(account))
            .map_err(|err| map_status(err.code(), Access::Write))
    }

    fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        match security_framework::passwords::generic_password(self.options(account)) {
            // A value this app did not write as UTF-8 is unreadable to it.
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| SecretError::Denied),
            Err(err) => match map_status(err.code(), Access::Read) {
                SecretError::NotFound => Ok(None),
                other => Err(other),
            },
        }
    }

    fn remove(&self, account: &str) -> Result<(), SecretError> {
        match security_framework::passwords::delete_generic_password_options(self.options(account)) {
            Ok(()) => Ok(()),
            Err(err) => match map_status(err.code(), Access::Write) {
                SecretError::NotFound => Ok(()),
                other => Err(other),
            },
        }
    }

    fn accounts(&self) -> Result<Vec<String>, SecretError> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        // Attributes only: no kSecReturnData, so no password is loaded.
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(&self.service)
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        match found {
            Ok(results) => Ok(results
                .iter()
                .filter_map(|result| result.simplify_dict())
                .filter_map(|attributes| attributes.get("acct").cloned())
                .collect()),
            Err(err) => match map_status(err.code(), Access::Read) {
                SecretError::NotFound => Ok(vec![]),
                other => Err(other),
            },
        }
    }
}

/// Stand-in so the crate still builds off macOS; every call is refused.
#[cfg(not(target_os = "macos"))]
pub struct MacKeychain;

#[cfg(not(target_os = "macos"))]
impl MacKeychain {
    pub fn new(_service: &str) -> Self {
        MacKeychain
    }
}

#[cfg(not(target_os = "macos"))]
impl SecretStore for MacKeychain {
    fn set(&self, _account: &str, _value: &str) -> Result<(), SecretError> {
        Err(SecretError::Denied)
    }
    fn get(&self, _account: &str) -> Result<Option<String>, SecretError> {
        Err(SecretError::Denied)
    }
    fn remove(&self, _account: &str) -> Result<(), SecretError> {
        Err(SecretError::Denied)
    }
    fn accounts(&self) -> Result<Vec<String>, SecretError> {
        Err(SecretError::Denied)
    }
}

// --- Tauri commands ----------------------------------------------------------
// Keychain calls can block on a system prompt, so each runs on the blocking
// pool instead of the main thread or an async worker.

async fn blocking<T, F>(access: Access, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&dyn SecretStore) -> Result<T, SecretError> + Send + 'static,
{
    let joined = tauri::async_runtime::spawn_blocking(move || work(&MacKeychain::new(SERVICE))).await;
    match joined {
        Ok(result) => result.map_err(|err| err.code().to_string()),
        Err(_) => Err(match access {
            Access::Write => SecretError::WriteFailed,
            Access::Read => SecretError::Denied,
        }
        .code()
        .to_string()),
    }
}

#[tauri::command]
pub async fn secret_set(workspace_id: String, key: String, value: String) -> Result<(), String> {
    blocking(Access::Write, move |store| set_secret(store, &workspace_id, &key, &value)).await
}

#[tauri::command]
pub async fn secret_get(workspace_id: String, key: String) -> Result<Option<String>, String> {
    blocking(Access::Read, move |store| get_secret(store, &workspace_id, &key)).await
}

#[tauri::command]
pub async fn secret_remove(workspace_id: String, key: String) -> Result<(), String> {
    blocking(Access::Write, move |store| remove_secret(store, &workspace_id, &key)).await
}

#[tauri::command]
pub async fn secret_presence(workspace_id: String) -> Result<Vec<String>, String> {
    blocking(Access::Read, move |store| secret_presence_in(store, &workspace_id)).await
}

fn vault_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(VAULT_FILE))
        .map_err(|_| SecretError::VaultUnreadable.code().to_string())
}

#[tauri::command]
pub async fn secret_migrate_file_vault(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<MigrationResult, String> {
    let path = vault_path(&app)?;
    blocking(Access::Write, move |store| migrate_file_vault(store, &workspace_id, &path)).await
}

#[tauri::command]
pub async fn secret_remove_file_vault(
    app: tauri::AppHandle,
    workspace_id: String,
) -> Result<RemovalResult, String> {
    let path = vault_path(&app)?;
    blocking(Access::Write, move |store| remove_file_vault(store, &workspace_id, &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    // --- In-memory fake -----------------------------------------------------

    /// Keychain stand-in. Records every operation (account names only) and,
    /// when `watch` is set, whether that file still existed at the time of
    /// the operation. The `*_on` switches inject failures for one account.
    #[derive(Default)]
    struct FakeKeychain {
        items: Mutex<BTreeMap<String, String>>,
        log: Mutex<Vec<String>>,
        file_seen: Mutex<Vec<bool>>,
        watch: Option<PathBuf>,
        /// `set` fails with `WriteFailed` and stores nothing.
        fail_set_on: Option<String>,
        /// `set` reports success but stores a different value.
        corrupt_set_on: Option<String>,
        /// `get` fails with `Locked` while an item exists for the account.
        fail_get_on: Option<String>,
        /// `remove` fails with `Denied` and keeps the item.
        fail_remove_on: Option<String>,
    }

    impl FakeKeychain {
        fn with_items(pairs: &[(&str, &str)]) -> Self {
            let fake = Self::default();
            for (account, value) in pairs {
                fake.items
                    .lock()
                    .unwrap()
                    .insert((*account).to_string(), (*value).to_string());
            }
            fake
        }

        fn record(&self, entry: String) {
            if let Some(path) = &self.watch {
                self.file_seen.lock().unwrap().push(path.exists());
            }
            self.log.lock().unwrap().push(entry);
        }

        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        fn item(&self, account: &str) -> Option<String> {
            self.items.lock().unwrap().get(account).cloned()
        }
    }

    fn hit(switch: &Option<String>, account: &str) -> bool {
        switch.as_deref() == Some(account)
    }

    impl SecretStore for FakeKeychain {
        fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
            self.record(format!("set:{account}"));
            if hit(&self.fail_set_on, account) {
                return Err(SecretError::WriteFailed);
            }
            let stored = if hit(&self.corrupt_set_on, account) { "garbled" } else { value };
            self.items
                .lock()
                .unwrap()
                .insert(account.to_string(), stored.to_string());
            Ok(())
        }

        fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
            self.record(format!("get:{account}"));
            let item = self.item(account);
            if item.is_some() && hit(&self.fail_get_on, account) {
                return Err(SecretError::Locked);
            }
            Ok(item)
        }

        fn remove(&self, account: &str) -> Result<(), SecretError> {
            self.record(format!("remove:{account}"));
            if hit(&self.fail_remove_on, account) {
                return Err(SecretError::Denied);
            }
            self.items.lock().unwrap().remove(account);
            Ok(())
        }

        fn accounts(&self) -> Result<Vec<String>, SecretError> {
            self.record("accounts".to_string());
            Ok(self.items.lock().unwrap().keys().cloned().collect())
        }
    }

    // --- Temporary vault files ----------------------------------------------

    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "keychain-vault-test-{}-{}",
                std::process::id(),
                NEXT_DIR.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn vault(&self, contents: &[u8]) -> PathBuf {
            let path = self.0.join(VAULT_FILE);
            std::fs::write(&path, contents).unwrap();
            path
        }

        fn missing_vault(&self) -> PathBuf {
            self.0.join(VAULT_FILE)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn watching(path: &Path, mut fake: FakeKeychain) -> FakeKeychain {
        fake.watch = Some(path.to_path_buf());
        fake
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    fn migration(migrated: &[&str], verified: &[&str], conflicts: &[&str]) -> MigrationResult {
        MigrationResult {
            migrated: strings(migrated),
            verified: strings(verified),
            conflicts: strings(conflicts),
        }
    }

    const FOUR_KEYS: &[u8] = br#"{"telegram.chatId":"-1001","glitchtip.url":"https://gt.example","glitchtip.token":"tok-1","glitchtip.org":"acme-org"}"#;

    // --- Account names --------------------------------------------------------

    #[test]
    fn account_name_pins_workspace_slash_key() {
        assert_eq!(account_name("acme", "glitchtip.token").unwrap(), "acme/glitchtip.token");
        assert!(account_name("../acme", "glitchtip.token").is_err());
        assert!(account_name("acme", "telegram\nbot").is_err());
    }

    #[test]
    fn account_name_rejects_bad_workspace_ids() {
        let max = "a".repeat(63);
        assert_eq!(account_name(&max, "k").unwrap(), format!("{max}/k"));
        assert_eq!(account_name("default", "k").unwrap(), "default/k");
        assert_eq!(account_name("0-team-9", "k").unwrap(), "0-team-9/k");
        for bad in [
            "",
            "-acme",
            "Acme",
            "acme/x",
            "acme.x",
            "acme_x",
            "acme ",
            "ac\nme",
            "acmé",
            &"a".repeat(64),
        ] {
            assert_eq!(
                account_name(bad, "glitchtip.token"),
                Err(SecretError::InvalidWorkspaceId),
                "workspace id {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn account_name_rejects_bad_keys() {
        let max = format!("k{}", "x".repeat(127));
        assert!(account_name("acme", &max).is_ok());
        for bad in [
            "",
            ".hidden",
            "-dash",
            "_under",
            "Upper",
            "a/b",
            "a b",
            "a\tb",
            "a\u{0}b",
            "ключ",
            &format!("k{}", "x".repeat(128)),
        ] {
            assert_eq!(
                account_name("acme", bad),
                Err(SecretError::InvalidKey),
                "key {bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn every_legacy_vault_key_is_a_valid_key() {
        // The file-vault key names written by the v1 wizard screens and
        // `src/lib/daemon.ts`. They are kept verbatim, so each must pass.
        for key in [
            "glitchtip.url",
            "glitchtip.token",
            "glitchtip.org",
            "glitchtip.team",
            "glitchtip.project",
            "telegram.botToken",
            "telegram.chatId",
            "telegram.chatTitle",
        ] {
            assert_eq!(
                account_name(LEGACY_WORKSPACE_ID, key).unwrap(),
                format!("default/{key}")
            );
        }
    }

    // --- Error codes ------------------------------------------------------------

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(SecretError::Denied.code(), "keychain-denied");
        assert_eq!(SecretError::Locked.code(), "keychain-locked");
        assert_eq!(SecretError::NotFound.code(), "secret-not-found");
        assert_eq!(SecretError::WriteFailed.code(), "keychain-write-failed");
        assert_eq!(SecretError::VaultCorrupt.code(), "vault-corrupt");
        assert_eq!(SecretError::VaultUnreadable.code(), "vault-unreadable");
        assert_eq!(SecretError::VaultNotVerified.code(), "vault-not-verified");
        assert_eq!(SecretError::VaultRemoveFailed.code(), "vault-remove-failed");
        assert_eq!(SecretError::InvalidWorkspaceId.code(), "invalid-workspace-id");
        assert_eq!(SecretError::InvalidKey.code(), "invalid-secret-key");
    }

    #[test]
    fn keychain_status_maps_to_user_safe_codes() {
        use Access::{Read, Write};
        assert_eq!(map_status(-25300, Read), SecretError::NotFound);
        assert_eq!(map_status(-25300, Write), SecretError::NotFound);
        // Locked keychain / no UI allowed / no keychain available.
        for status in [-25308, -25315, -25320, -25291, -25307] {
            assert_eq!(map_status(status, Read), SecretError::Locked, "{status}");
            assert_eq!(map_status(status, Write), SecretError::Locked, "{status}");
        }
        // User cancelled the prompt, wrong password, ACL or entitlement refusal.
        for status in [-128, -25293, -25243, -25244, -34018, -34020, -61, -25292] {
            assert_eq!(map_status(status, Read), SecretError::Denied, "{status}");
            assert_eq!(map_status(status, Write), SecretError::Denied, "{status}");
        }
        // Anything unrecognised: a failed mutation is a failed write, a failed
        // read is reported as access denied.
        assert_eq!(map_status(-25299, Write), SecretError::WriteFailed);
        assert_eq!(map_status(-50, Write), SecretError::WriteFailed);
        assert_eq!(map_status(-26275, Read), SecretError::Denied);
    }

    // --- get / set / remove / presence ------------------------------------------

    #[test]
    fn set_get_remove_round_trip_through_account_names() {
        let fake = FakeKeychain::default();
        set_secret(&fake, "acme", "glitchtip.token", "tok-1").unwrap();
        assert_eq!(fake.item("acme/glitchtip.token").as_deref(), Some("tok-1"));
        assert_eq!(
            get_secret(&fake, "acme", "glitchtip.token").unwrap().as_deref(),
            Some("tok-1")
        );
        assert_eq!(get_secret(&fake, "acme", "glitchtip.url").unwrap(), None);
        // Empty strings are legal values (the v1 screens store them).
        set_secret(&fake, "acme", "glitchtip.team", "").unwrap();
        assert_eq!(
            get_secret(&fake, "acme", "glitchtip.team").unwrap().as_deref(),
            Some("")
        );
        remove_secret(&fake, "acme", "glitchtip.token").unwrap();
        assert_eq!(get_secret(&fake, "acme", "glitchtip.token").unwrap(), None);
        // Removing an absent secret is a no-op, like the file vault was.
        remove_secret(&fake, "acme", "glitchtip.token").unwrap();
    }

    #[test]
    fn invalid_identifiers_never_reach_the_keychain() {
        let fake = FakeKeychain::default();
        assert_eq!(
            set_secret(&fake, "../acme", "glitchtip.token", "v"),
            Err(SecretError::InvalidWorkspaceId)
        );
        assert_eq!(
            get_secret(&fake, "acme", "telegram\nbot"),
            Err(SecretError::InvalidKey)
        );
        assert_eq!(
            remove_secret(&fake, "acme", "a/b"),
            Err(SecretError::InvalidKey)
        );
        assert_eq!(
            secret_presence_in(&fake, "Acme"),
            Err(SecretError::InvalidWorkspaceId)
        );
        assert!(fake.log().is_empty(), "no Keychain call for a bad identifier");
    }

    #[test]
    fn presence_returns_sorted_key_names_for_one_workspace_only() {
        let fake = FakeKeychain::with_items(&[
            ("acme/telegram.botToken", "bot"),
            ("acme/glitchtip.token", "tok"),
            ("acme-2/glitchtip.url", "https://other"),
            ("other/glitchtip.token", "x"),
            ("acme/", "empty-key"),
            ("acme/bad key", "junk"),
            ("acme", "no-slash"),
        ]);
        assert_eq!(
            secret_presence_in(&fake, "acme").unwrap(),
            strings(&["glitchtip.token", "telegram.botToken"])
        );
        // Attributes only: presence never loads a password.
        assert_eq!(fake.log(), strings(&["accounts"]));
        assert!(secret_presence_in(&fake, "nobody").unwrap().is_empty());
    }

    // --- File vault migration (never deletes the file) --------------------------

    #[test]
    fn keychain_migration_of_a_missing_vault_is_empty() {
        let dir = TempDir::new();
        let fake = FakeKeychain::default();
        let result = migrate_file_vault(&fake, "acme", &dir.missing_vault()).unwrap();
        assert_eq!(result, migration(&[], &[], &[]));
        assert!(fake.log().is_empty());
    }

    #[test]
    fn keychain_migration_writes_missing_keys_verifies_them_and_keeps_the_file() {
        let dir = TempDir::new();
        let body = br#"{"telegram.botToken":"bot-1","glitchtip.url":"https://gt.example","glitchtip.token":"tok-1"}"#;
        let path = dir.vault(body);
        let fake = watching(&path, FakeKeychain::default());

        let result = migrate_file_vault(&fake, "acme", &path).unwrap();

        assert_eq!(
            result,
            migration(&["glitchtip.token", "glitchtip.url", "telegram.botToken"], &[], &[])
        );
        assert_eq!(std::fs::read(&path).unwrap(), body.to_vec(), "migration never deletes");
        assert_eq!(fake.item("acme/glitchtip.token").as_deref(), Some("tok-1"));
        assert_eq!(fake.item("acme/glitchtip.url").as_deref(), Some("https://gt.example"));
        assert_eq!(fake.item("acme/telegram.botToken").as_deref(), Some("bot-1"));
        // Ordering: read every key, write the missing ones, read those back.
        assert_eq!(
            fake.log(),
            strings(&[
                "get:acme/glitchtip.token",
                "get:acme/glitchtip.url",
                "get:acme/telegram.botToken",
                "set:acme/glitchtip.token",
                "set:acme/glitchtip.url",
                "set:acme/telegram.botToken",
                "get:acme/glitchtip.token",
                "get:acme/glitchtip.url",
                "get:acme/telegram.botToken",
            ])
        );
        let seen = fake.file_seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 9);
        assert!(seen.iter().all(|present| *present));
    }

    #[test]
    fn keychain_migration_counts_equal_items_as_verified_and_keeps_conflicts() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let fake = FakeKeychain::with_items(&[
            ("acme/glitchtip.token", "tok-1"),
            ("acme/glitchtip.url", "https://newer.example"),
        ]);

        let result = migrate_file_vault(&fake, "acme", &path).unwrap();

        assert_eq!(
            result,
            migration(&["glitchtip.org", "telegram.chatId"], &["glitchtip.token"], &["glitchtip.url"])
        );
        // The conflicting Keychain value is kept, never overwritten.
        assert_eq!(fake.item("acme/glitchtip.url").as_deref(), Some("https://newer.example"));
        assert!(!fake.log().iter().any(|op| op == "set:acme/glitchtip.url"));
        assert!(!fake.log().iter().any(|op| op == "set:acme/glitchtip.token"));
        assert!(path.exists());
    }

    #[test]
    fn keychain_migration_failed_insert_rolls_back_this_run_and_keeps_the_file() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let mut fake = FakeKeychain::with_items(&[("acme/glitchtip.org", "acme-org")]);
        fake.fail_set_on = Some("acme/glitchtip.url".to_string());

        assert_eq!(
            migrate_file_vault(&fake, "acme", &path),
            Err(SecretError::WriteFailed)
        );

        assert_eq!(std::fs::read(&path).unwrap(), FOUR_KEYS.to_vec(), "source untouched");
        // The item written earlier in this run is removed again …
        assert_eq!(fake.item("acme/glitchtip.token"), None);
        assert!(fake.log().contains(&"remove:acme/glitchtip.token".to_string()));
        // … the item that was already there is left alone …
        assert_eq!(fake.item("acme/glitchtip.org").as_deref(), Some("acme-org"));
        assert!(!fake.log().contains(&"remove:acme/glitchtip.org".to_string()));
        // … and nothing after the failure is written.
        assert!(!fake.log().contains(&"set:acme/telegram.chatId".to_string()));
        assert_eq!(fake.item("acme/telegram.chatId"), None);
    }

    #[test]
    fn keychain_migration_read_back_mismatch_rolls_back_and_a_retry_migrates_again() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let mut fake = FakeKeychain::default();
        fake.corrupt_set_on = Some("acme/glitchtip.url".to_string());

        assert_eq!(
            migrate_file_vault(&fake, "acme", &path),
            Err(SecretError::WriteFailed)
        );
        assert_eq!(std::fs::read(&path).unwrap(), FOUR_KEYS.to_vec());
        assert!(fake.items.lock().unwrap().is_empty(), "every write of the run rolled back");

        // A healthy retry writes every key again; nothing is silently skipped.
        fake.corrupt_set_on = None;
        let result = migrate_file_vault(&fake, "acme", &path).unwrap();
        assert_eq!(
            result,
            migration(
                &["glitchtip.org", "glitchtip.token", "glitchtip.url", "telegram.chatId"],
                &[],
                &[]
            )
        );
        assert_eq!(fake.item("acme/glitchtip.url").as_deref(), Some("https://gt.example"));
        assert!(path.exists());
    }

    #[test]
    fn keychain_migration_retry_after_a_failed_rollback_reports_a_conflict() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let mut fake = FakeKeychain::default();
        fake.corrupt_set_on = Some("acme/glitchtip.url".to_string());
        fake.fail_remove_on = Some("acme/glitchtip.url".to_string());

        assert_eq!(
            migrate_file_vault(&fake, "acme", &path),
            Err(SecretError::WriteFailed)
        );
        // Rollback could not remove the bad item.
        assert_eq!(fake.item("acme/glitchtip.url").as_deref(), Some("garbled"));

        fake.corrupt_set_on = None;
        let result = migrate_file_vault(&fake, "acme", &path).unwrap();
        // The wrong value is surfaced as a conflict, never counted as done.
        assert_eq!(
            result,
            migration(&["glitchtip.org", "glitchtip.token", "telegram.chatId"], &[], &["glitchtip.url"])
        );
        assert_eq!(std::fs::read(&path).unwrap(), FOUR_KEYS.to_vec());
    }

    #[test]
    fn keychain_migration_read_back_failure_rolls_back() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let mut fake = FakeKeychain::default();
        // Absent at the first read, so the key is written; the read-back fails.
        fake.fail_get_on = Some("acme/glitchtip.token".to_string());

        assert_eq!(migrate_file_vault(&fake, "acme", &path), Err(SecretError::Locked));
        assert!(fake.items.lock().unwrap().is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), FOUR_KEYS.to_vec());
    }

    #[test]
    fn keychain_migration_read_failure_before_writing_changes_nothing() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let mut fake = FakeKeychain::with_items(&[("acme/glitchtip.token", "tok-1")]);
        fake.fail_get_on = Some("acme/glitchtip.token".to_string());

        assert_eq!(migrate_file_vault(&fake, "acme", &path), Err(SecretError::Locked));
        assert!(!fake.log().iter().any(|op| op.starts_with("set:") || op.starts_with("remove:")));
        assert_eq!(fake.item("acme/glitchtip.token").as_deref(), Some("tok-1"));
    }

    #[test]
    fn keychain_migration_is_scoped_to_the_workspace() {
        let dir = TempDir::new();
        let path = dir.vault(br#"{"glitchtip.token":"tok-1"}"#);
        // The same key in another workspace does not count.
        let fake = FakeKeychain::with_items(&[("other/glitchtip.token", "tok-1")]);

        let result = migrate_file_vault(&fake, "acme", &path).unwrap();

        assert_eq!(result, migration(&["glitchtip.token"], &[], &[]));
        assert_eq!(fake.item("acme/glitchtip.token").as_deref(), Some("tok-1"));
    }

    #[test]
    fn keychain_migration_of_an_empty_vault_keeps_the_file() {
        let dir = TempDir::new();
        let path = dir.vault(b"{}");
        let fake = FakeKeychain::default();
        assert_eq!(migrate_file_vault(&fake, "acme", &path).unwrap(), migration(&[], &[], &[]));
        assert!(path.exists());
    }

    const CORRUPT_BODIES: [&[u8]; 7] = [
        b"not-json{",
        b"[]",
        b"\"just a string\"",
        b"null",
        br#"{"glitchtip.token": 42}"#,
        br#"{"bad key": "value"}"#,
        &[0xff, 0xfe, 0x7b, 0x7d],
    ];

    #[test]
    fn keychain_migration_rejects_a_corrupt_vault_and_keeps_it() {
        for body in CORRUPT_BODIES {
            let dir = TempDir::new();
            let path = dir.vault(body);
            let fake = FakeKeychain::default();
            assert_eq!(
                migrate_file_vault(&fake, "acme", &path),
                Err(SecretError::VaultCorrupt),
                "body {:?}",
                String::from_utf8_lossy(body)
            );
            assert_eq!(std::fs::read(&path).unwrap(), body.to_vec());
            assert!(fake.log().is_empty(), "nothing written for a corrupt vault");
        }
    }

    #[test]
    fn keychain_migration_reports_an_unreadable_vault() {
        let dir = TempDir::new();
        // A directory where the file should be: exists, but cannot be read.
        let path = dir.missing_vault();
        std::fs::create_dir(&path).unwrap();
        let fake = FakeKeychain::default();
        assert_eq!(
            migrate_file_vault(&fake, "acme", &path),
            Err(SecretError::VaultUnreadable)
        );
        assert!(path.is_dir());
        assert!(fake.log().is_empty());
    }

    #[test]
    fn keychain_migration_rejects_a_bad_workspace_before_touching_anything() {
        let dir = TempDir::new();
        let body = br#"{"glitchtip.token":"tok-1"}"#;
        let path = dir.vault(body);
        let fake = FakeKeychain::default();
        assert_eq!(
            migrate_file_vault(&fake, "../acme", &path),
            Err(SecretError::InvalidWorkspaceId)
        );
        assert_eq!(std::fs::read(&path).unwrap(), body.to_vec());
        assert!(fake.log().is_empty());
    }

    // --- File vault removal (only after every key matches) ----------------------

    fn all_four_in(workspace: &str) -> FakeKeychain {
        FakeKeychain::with_items(&[
            (&format!("{workspace}/glitchtip.org"), "acme-org"),
            (&format!("{workspace}/glitchtip.token"), "tok-1"),
            (&format!("{workspace}/glitchtip.url"), "https://gt.example"),
            (&format!("{workspace}/telegram.chatId"), "-1001"),
        ])
    }

    #[test]
    fn keychain_vault_removal_of_a_missing_file_is_a_no_op() {
        let dir = TempDir::new();
        let fake = FakeKeychain::default();
        assert_eq!(
            remove_file_vault(&fake, "acme", &dir.missing_vault()).unwrap(),
            RemovalResult { removed: false }
        );
        assert!(fake.log().is_empty());
    }

    #[test]
    fn keychain_vault_removal_deletes_only_after_every_key_matches() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let fake = watching(&path, all_four_in("acme"));

        assert_eq!(
            remove_file_vault(&fake, "acme", &path).unwrap(),
            RemovalResult { removed: true }
        );

        assert!(!path.exists());
        assert_eq!(
            fake.log(),
            strings(&[
                "get:acme/glitchtip.org",
                "get:acme/glitchtip.token",
                "get:acme/glitchtip.url",
                "get:acme/telegram.chatId",
            ])
        );
        let seen = fake.file_seen.lock().unwrap().clone();
        assert!(seen.iter().all(|present| *present), "every key checked before the unlink");
        // Removal never writes or deletes Keychain items.
        assert_eq!(fake.items.lock().unwrap().len(), 4);
    }

    #[test]
    fn keychain_vault_removal_refuses_when_a_key_is_missing() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let fake = all_four_in("acme");
        fake.items.lock().unwrap().remove("acme/telegram.chatId");

        assert_eq!(
            remove_file_vault(&fake, "acme", &path),
            Err(SecretError::VaultNotVerified)
        );
        assert_eq!(std::fs::read(&path).unwrap(), FOUR_KEYS.to_vec());
    }

    #[test]
    fn keychain_vault_removal_refuses_when_a_key_differs() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let fake = all_four_in("acme");
        fake.items
            .lock()
            .unwrap()
            .insert("acme/glitchtip.url".to_string(), "https://newer.example".to_string());

        assert_eq!(
            remove_file_vault(&fake, "acme", &path),
            Err(SecretError::VaultNotVerified)
        );
        assert_eq!(std::fs::read(&path).unwrap(), FOUR_KEYS.to_vec());
    }

    #[test]
    fn keychain_vault_removal_checks_the_requested_workspace_only() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let fake = all_four_in("other");

        assert_eq!(
            remove_file_vault(&fake, "acme", &path),
            Err(SecretError::VaultNotVerified)
        );
        assert!(path.exists());
    }

    #[test]
    fn keychain_vault_removal_refuses_on_an_unlink_failure() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let fake = all_four_in("acme");

        let result = remove_file_vault_with(&fake, "acme", &path, |_| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });

        assert_eq!(result, Err(SecretError::VaultRemoveFailed));
        assert_eq!(std::fs::read(&path).unwrap(), FOUR_KEYS.to_vec());
    }

    #[test]
    fn keychain_vault_removal_passes_keychain_errors_through() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let mut fake = all_four_in("acme");
        fake.fail_get_on = Some("acme/glitchtip.token".to_string());

        assert_eq!(remove_file_vault(&fake, "acme", &path), Err(SecretError::Locked));
        assert!(path.exists());
    }

    #[test]
    fn keychain_vault_removal_rejects_bad_input_and_keeps_the_file() {
        let fake = all_four_in("acme");
        for body in CORRUPT_BODIES {
            let dir = TempDir::new();
            let path = dir.vault(body);
            assert_eq!(remove_file_vault(&fake, "acme", &path), Err(SecretError::VaultCorrupt));
            assert_eq!(std::fs::read(&path).unwrap(), body.to_vec());
        }
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        assert_eq!(
            remove_file_vault(&fake, "../acme", &path),
            Err(SecretError::InvalidWorkspaceId)
        );
        let unreadable = TempDir::new();
        let dir_path = unreadable.missing_vault();
        std::fs::create_dir(&dir_path).unwrap();
        assert_eq!(
            remove_file_vault(&fake, "acme", &dir_path),
            Err(SecretError::VaultUnreadable)
        );
        assert!(path.exists() && dir_path.is_dir());
    }

    #[test]
    fn keychain_vault_removal_after_migration_round_trip() {
        let dir = TempDir::new();
        let path = dir.vault(FOUR_KEYS);
        let fake = FakeKeychain::default();

        // Refused before migration, allowed once every key is verified.
        assert_eq!(
            remove_file_vault(&fake, "acme", &path),
            Err(SecretError::VaultNotVerified)
        );
        migrate_file_vault(&fake, "acme", &path).unwrap();
        assert_eq!(
            migrate_file_vault(&fake, "acme", &path).unwrap(),
            migration(
                &[],
                &["glitchtip.org", "glitchtip.token", "glitchtip.url", "telegram.chatId"],
                &[]
            ),
            "a second migration only verifies"
        );
        assert_eq!(
            remove_file_vault(&fake, "acme", &path).unwrap(),
            RemovalResult { removed: true }
        );
        assert!(!path.exists());
    }

    // --- Live Keychain (manual) --------------------------------------------------

    /// Deletes every item under the throwaway service, even when an
    /// assertion in the live test panics.
    #[cfg(target_os = "macos")]
    struct LiveCleanup<'a>(&'a MacKeychain);

    #[cfg(target_os = "macos")]
    impl Drop for LiveCleanup<'_> {
        fn drop(&mut self) {
            if let Ok(accounts) = self.0.accounts() {
                for account in accounts {
                    let _ = self.0.remove(&account);
                }
            }
        }
    }

    /// Runs against the real login Keychain under a throwaway service name.
    /// Run manually: `cargo test -- --ignored keychain_live`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches the real login Keychain; run with --ignored keychain_live"]
    fn keychain_live_round_trip_and_migration() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let service = format!("{SERVICE}.test-{}-{nanos}", std::process::id());
        let store = MacKeychain::new(&service);
        let cleanup = LiveCleanup(&store);
        println!("live service: {service}");

        assert!(secret_presence_in(&store, "live").unwrap().is_empty());

        set_secret(&store, "live", "glitchtip.token", "first value ✓\nline two").unwrap();
        assert_eq!(
            get_secret(&store, "live", "glitchtip.token").unwrap().as_deref(),
            Some("first value ✓\nline two")
        );
        set_secret(&store, "live", "glitchtip.token", "second").unwrap();
        assert_eq!(
            get_secret(&store, "live", "glitchtip.token").unwrap().as_deref(),
            Some("second"),
            "set replaces an existing item"
        );
        set_secret(&store, "live", "glitchtip.team", "").unwrap();
        assert_eq!(
            get_secret(&store, "live", "glitchtip.team").unwrap().as_deref(),
            Some(""),
            "empty values round-trip"
        );

        // Account matching must be case-sensitive, or camelCase legacy keys
        // could collide with a lower-case twin.
        set_secret(&store, "live", "telegram.botToken", "bot-camel").unwrap();
        assert_eq!(get_secret(&store, "live", "telegram.bottoken").unwrap(), None);
        set_secret(&store, "live", "telegram.bottoken", "bot-lower").unwrap();
        assert_eq!(
            get_secret(&store, "live", "telegram.botToken").unwrap().as_deref(),
            Some("bot-camel"),
            "the lower-case twin is a separate item"
        );
        assert_eq!(
            get_secret(&store, "live", "telegram.bottoken").unwrap().as_deref(),
            Some("bot-lower")
        );

        set_secret(&store, "live-2", "glitchtip.url", "https://other").unwrap();
        let presence = secret_presence_in(&store, "live").unwrap();
        println!("presence(live): {presence:?}");
        assert_eq!(
            presence,
            strings(&["glitchtip.team", "glitchtip.token", "telegram.botToken", "telegram.bottoken"])
        );

        remove_secret(&store, "live", "glitchtip.token").unwrap();
        assert_eq!(get_secret(&store, "live", "glitchtip.token").unwrap(), None);
        remove_secret(&store, "live", "glitchtip.token").unwrap();

        let dir = TempDir::new();
        let path = dir.vault(br#"{"glitchtip.url":"https://gt.example","telegram.chatId":"-1001"}"#);
        assert_eq!(
            remove_file_vault(&store, "live-migrate", &path),
            Err(SecretError::VaultNotVerified),
            "removal refused before migration"
        );
        let first = migrate_file_vault(&store, "live-migrate", &path).unwrap();
        println!("migration: {first:?}");
        assert_eq!(first, migration(&["glitchtip.url", "telegram.chatId"], &[], &[]));
        assert!(path.exists(), "migration keeps the file");
        let second = migrate_file_vault(&store, "live-migrate", &path).unwrap();
        println!("second migration: {second:?}");
        assert_eq!(second, migration(&[], &["glitchtip.url", "telegram.chatId"], &[]));
        let removal = remove_file_vault(&store, "live-migrate", &path).unwrap();
        println!("removal: {removal:?}");
        assert_eq!(removal, RemovalResult { removed: true });
        assert!(!path.exists());

        drop(cleanup);
        let left = store.accounts().unwrap();
        println!("items left under the throwaway service: {}", left.len());
        assert!(left.is_empty(), "live test must delete what it creates");
    }
}
