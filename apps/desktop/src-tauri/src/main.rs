#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_install;
mod app_menu;
mod helper;
mod keychain;
mod remote;

use std::collections::HashMap;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use tauri::Manager;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_shell::ShellExt;

// The v1 relay daemon's launchd label, plist and log names. The full plist XML
// is built here by `build_plist()`; the renderer only sends the env record +
// RunAtLoad flag over IPC — finished XML is never accepted from the frontend.
const DAEMON_LABEL: &str = "dev.ctimothe.glitchtip-onboarding.relay";
const PLIST_FILE: &str = "dev.ctimothe.glitchtip-onboarding.relay.plist";
const LOG_FILE: &str = "relay.log";

// Sentinel marking a redacted secret in `relay_env_load` output. The
// frontend displays it as-is and sends it back untouched for secrets the
// user did not change; `relay_env_save` keeps the stored value in that
// case. Must match REDACTED_ENV_VALUE in `src/lib/daemon.ts`.
const REDACTED: &str = "••••••••";

// Env names whose values are secrets (from assets/relay/server.js:12-18 and
// :32-34 — the relay's env-only config). These are redacted on load and
// always re-sourced from the vault on install.
const SECRET_KEYS: [&str; 4] = [
    "TELEGRAM_ALERT_BOT_TOKEN",
    "GLITCHTIP_API_TOKEN",
    "PROJECT_LOOKUP_TOKENS",
    "OBSERVABILITY_LOOKUP_TOKEN",
];

// Env names re-synced from the vault on every enable. Must match
// VAULT_TO_ENV in `src/lib/daemon.ts`. On enable these come ONLY from the
// incoming plist (fresh vault values assembled by the frontend); stale
// copies in an existing plist are dropped so a cleared vault value falls
// back to the relay default instead of resurrecting an old token. PORT is
// deliberately NOT in this list: it has no vault source, so a user PORT
// edit is preserved verbatim and the default is only inserted when neither
// the existing plist nor the incoming plist sets it.
const VAULT_SYNCED_KEYS: [&str; 5] = [
    "TELEGRAM_ALERT_BOT_TOKEN",
    "TELEGRAM_ALERT_CHAT_ID",
    "GLITCHTIP_API_BASE",
    "GLITCHTIP_API_TOKEN",
    "DEFAULT_PROJECT",
];
const PORT_KEY: &str = "PORT";
// Must match DEFAULT_RELAY_PORT in `src/lib/daemon-plist.ts`.
const PORT_DEFAULT: &str = "8090";

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "Could not find your home folder (HOME is not set).".to_string())
}

fn plist_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library/LaunchAgents").join(PLIST_FILE))
}

fn log_path() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join("Library/Logs")
        .join(DAEMON_LABEL)
        .join(LOG_FILE))
}

fn friendly_io(action: &str, path: &std::path::Path, err: &std::io::Error) -> String {
    use std::io::ErrorKind as K;
    let reason = match err.kind() {
        K::NotFound => "the file does not exist".to_string(),
        K::PermissionDenied => "permission was denied".to_string(),
        K::AlreadyExists => "the file already exists".to_string(),
        _ => format!("the system reported: {}", err),
    };
    format!("Could not {} {} — {}.", action, path.display(), reason)
}

/// Run /bin/launchctl through the shell plugin (absolute path, never PATH
/// lookup) and return its stdout. Frontend code can only reach launchctl
/// through the `shell:allow-execute` capability scope in
/// capabilities/default.json, which pins the same binary and the
/// load|unload|list|print subcommands.
async fn launchctl(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    let output = app
        .shell()
        .command("/bin/launchctl")
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Could not start launchctl — the system reported: {e}."))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("launchctl {} did not succeed.", args.join(" "))
        } else {
            format!("launchctl {} did not succeed — {}.", args.join(" "), detail)
        })
    }
}

/// Parse `launchctl list <label>` output. Prints a header plus one row per
/// job: `PID\tStatus\tLabel`. A numeric PID means the job has a live
/// process; `-` means loaded but currently without one.
fn pid_from_list_output(output: &str) -> Option<Option<u32>> {
    for line in output.lines().skip(1) {
        let mut cols = line.split_whitespace();
        if let (Some(pid), Some(_status), Some(label)) = (cols.next(), cols.next(), cols.next()) {
            if label == DAEMON_LABEL {
                if pid == "-" {
                    return Some(None);
                }
                if let Ok(n) = pid.parse::<u32>() {
                    return Some(Some(n));
                }
            }
        }
    }
    None
}

async fn current_status(app: &tauri::AppHandle) -> Result<String, String> {
    if !plist_path()?.exists() {
        return Ok("not-installed".to_string());
    }
    match launchctl(app, &["list", DAEMON_LABEL]).await {
        Ok(out) => match pid_from_list_output(&out) {
            Some(Some(_)) => Ok("running".to_string()),
            _ => Ok("stopped".to_string()),
        },
        Err(_) => Ok("stopped".to_string()),
    }
}

/// Status detail for the Task 3 status card (state + PID). The PID comes
/// from the same `launchctl list` parse as `current_status` (numeric PID =
/// running); it is null unless the state is running.
#[derive(serde::Serialize)]
struct StatusDetail {
    state: String,
    pid: Option<u32>,
}

/// Pure mapping behind `daemon_status_detail` (unit-tested): plist presence
/// plus the `launchctl list` outcome (`Ok(output)` / `Err`) map to
/// (state, pid). PID is Some only while running.
fn status_detail_parts(plist_exists: bool, list: Result<&str, ()>) -> (String, Option<u32>) {
    if !plist_exists {
        return ("not-installed".to_string(), None);
    }
    match list {
        Ok(out) => match pid_from_list_output(out) {
            Some(Some(pid)) => ("running".to_string(), Some(pid)),
            _ => ("stopped".to_string(), None),
        },
        Err(()) => ("stopped".to_string(), None),
    }
}

#[tauri::command]
async fn daemon_status_detail(app: tauri::AppHandle) -> Result<StatusDetail, String> {
    let exists = plist_path()?.exists();
    // A failing `list` means loaded-but-not-queryable, i.e. stopped — the
    // same reading `current_status` uses (never an IPC error).
    let list = launchctl(&app, &["list", DAEMON_LABEL]).await;
    let (state, pid) = status_detail_parts(exists, list.as_deref().map_err(|_| ()));
    Ok(StatusDetail { state, pid })
}

/// Absolute paths the install plist is built from: (node sidecar, relay
/// entry, plist file, log file). Shared by `daemon_paths` (which exposes
/// them to the UI for the consent sheet) and `daemon_set_enabled` (which
/// builds the full plist from them — the renderer never supplies paths or
/// XML over IPC).
///
/// The node sidecar ships as bundle `externalBin` and — per the shell
/// plugin's own resolution (`relative_command_path` in
/// tauri-plugin-shell 2.3.6 `src/process/mod.rs`) — lives next to the app
/// executable. The first existing candidate wins; the tried locations are
/// listed in the error so Task 5's live proof can diagnose the bundle
/// layout instead of guessing it here.
fn resolve_daemon_paths(app: &tauri::AppHandle) -> Result<(String, String, String, String), String> {
    let triple = format!("{}-apple-darwin", std::env::consts::ARCH);
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Could not locate the app executable — the system reported: {e}."))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Could not locate the app executable.".to_string())?;
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidates = [
        exe_dir.join("binaries").join(format!("node-{triple}")),
        exe_dir.join("binaries").join("node"),
        cwd.join("src-tauri/binaries").join(format!("node-{triple}")),
        cwd.join("apps/desktop/src-tauri/binaries")
            .join(format!("node-{triple}")),
    ];
    let node = candidates
        .iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            let tried = candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            format!("Could not find the vendored Node sidecar. Looked in: {tried}.")
        })?
        .display()
        .to_string();

    // Resource path string is identical to tauri.conf.json's entry
    // ("../../../assets/relay/server.js" — Task 1 report §3); the resolver
    // maps it into the bundle ($RESOURCE/_up_/_up_/_up_/...).
    let entry = app
        .path()
        .resolve(
            "../../../assets/relay/server.js",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Could not resolve the bundled relay entry — {e}."))?;
    if !entry.is_file() {
        return Err(format!(
            "The bundled relay entry is missing at {}. Reinstall the app.",
            entry.display()
        ));
    }

    Ok((
        node,
        entry.display().to_string(),
        plist_path()?.display().to_string(),
        log_path()?.display().to_string(),
    ))
}

#[tauri::command]
async fn daemon_paths(app: tauri::AppHandle) -> Result<(String, String, String, String), String> {
    resolve_daemon_paths(&app)
}

/// Write plist bytes so the file is 0600 from creation (no write-then-chmod
/// window where group/world could read the vault-copied tokens) AND 0600
/// after every write (`mode` only applies at creation, so a pre-existing
/// lax file — umask drift, restore, hand-chmod — is re-asserted here to
/// repair drift on reinstalls/rewrites).
fn write_plist_0600(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| friendly_io("write the relay plist at", path, &e))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| friendly_io("write the relay plist at", path, &e))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| friendly_io("secure the relay plist at", path, &e))
}

/// Full plist XML, byte-identical in shape to the frontend `buildPlist()` in
/// `src/lib/daemon-plist.ts` (same key order, sorted env, same escaping).
/// `env` may arrive unsorted; it is sorted here so rewrites are
/// deterministic regardless of IPC map order.
fn build_plist(
    node_path: &str,
    relay_entry: &str,
    log_path: &str,
    env: &[(String, String)],
    run_at_load: bool,
) -> String {
    let mut sorted = env.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    out.push_str("<plist version=\"1.0\">\n");
    out.push_str("<dict>\n");
    out.push_str("\t<key>Label</key>\n");
    out.push_str(&format!("\t<string>{}</string>\n", escape_xml(DAEMON_LABEL)));
    out.push_str("\t<key>ProgramArguments</key>\n");
    out.push_str("\t<array>\n");
    out.push_str(&format!("\t\t<string>{}</string>\n", escape_xml(node_path)));
    out.push_str(&format!("\t\t<string>{}</string>\n", escape_xml(relay_entry)));
    out.push_str("\t</array>\n");
    out.push_str("\t<key>EnvironmentVariables</key>\n");
    out.push_str("\t<dict>\n");
    for (key, value) in &sorted {
        out.push_str(&format!("\t\t<key>{}</key>\n", escape_xml(key)));
        out.push_str(&format!("\t\t<string>{}</string>\n", escape_xml(value)));
    }
    out.push_str("\t</dict>\n");
    out.push_str("\t<key>RunAtLoad</key>\n");
    out.push_str(if run_at_load { "\t<true/>\n" } else { "\t<false/>\n" });
    out.push_str("\t<key>KeepAlive</key>\n");
    out.push_str("\t<true/>\n");
    out.push_str("\t<key>StandardOutPath</key>\n");
    out.push_str(&format!("\t<string>{}</string>\n", escape_xml(log_path)));
    out.push_str("\t<key>StandardErrorPath</key>\n");
    out.push_str(&format!("\t<string>{}</string>\n", escape_xml(log_path)));
    out.push_str("</dict>\n");
    out.push_str("</plist>\n");
    out
}

/// Pure parse behind `daemon_get_boot` (unit-tested): the RunAtLoad switch
/// of an installed plist. Errors on a missing/malformed switch (same shape
/// `daemon_set_boot` expects) so hand-edited plists surface instead of
/// silently seeding the checkbox wrong.
fn parse_run_at_load(plist: &str) -> Result<bool, String> {
    let head = "<key>RunAtLoad</key>";
    let h = plist.find(head).ok_or_else(|| {
        "Could not find the RunAtLoad switch in the relay plist — was it edited by hand? Re-enable the relay to rewrite it.".to_string()
    })?;
    let after = plist[h + head.len()..].trim_start();
    if after.starts_with("<true/>") {
        Ok(true)
    } else if after.starts_with("<false/>") {
        Ok(false)
    } else {
        Err("Could not find the RunAtLoad switch in the relay plist — was it edited by hand? Re-enable the relay to rewrite it.".to_string())
    }
}

/// Seed for the boot checkbox: true only when an installed plist carries
/// `<true/>`. An absent plist means nothing is installed, so false (never an
/// error). Capability-neutral — plain std file read, no new scopes.
#[tauri::command]
async fn daemon_get_boot() -> Result<bool, String> {
    let plist = plist_path()?;
    if !plist.exists() {
        return Ok(false);
    }
    let xml = std::fs::read_to_string(&plist)
        .map_err(|e| friendly_io("read the relay plist at", &plist, &e))?;
    parse_run_at_load(&xml)
}

#[tauri::command]
async fn daemon_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
    env: Option<HashMap<String, String>>,
    run_at_load: Option<bool>,
) -> Result<String, String> {
    let plist = plist_path()?;
    if !enabled {
        if !plist.exists() {
            return Ok("The relay is not installed.".to_string());
        }
        if current_status(&app).await? != "not-installed" {
            // Best effort: a job that is already unloaded reports "stopped".
            let _ = launchctl(&app, &["unload", &plist.display().to_string()]).await;
        }
        std::fs::remove_file(&plist)
            .map_err(|e| friendly_io("remove the relay plist at", &plist, &e))?;
        return Ok(
            "The relay is disabled. Its plist was removed; the log file was kept.".to_string(),
        );
    }

    // Enable-time env merge (never rebuild from displayed/redacted values):
    // (1) the existing plist's env entries are preserved verbatim — this is
    // a raw file read, so non-vault secrets with no vault source
    // (PROJECT_LOOKUP_TOKENS, OBSERVABILITY_LOOKUP_TOKEN) and user edits
    // (PROJECT_APP_BASES, PORT) survive reinstall; (2) vault-synced keys
    // come only from the incoming env record (fresh vault re-sync assembled
    // by the frontend); (3) the explicit enable patch is baked into the
    // incoming env last by the frontend, so it wins here. An unreadable
    // existing env falls back to incoming-only rather than blocking enable.
    let incoming_map = env.unwrap_or_default();
    let mut incoming: Vec<(String, String)> = Vec::with_capacity(incoming_map.len());
    for (key, value) in incoming_map {
        if !valid_env_key(&key) {
            return Err(format!("“{key}” is not a valid setting name — use letters, digits, and underscores."));
        }
        if value.len() > 100_000 {
            return Err(format!("The value for “{key}” is too long (over 100 KB)."));
        }
        incoming.push((key, value));
    }
    let mut base: Vec<(String, String)> = Vec::new();
    if plist.exists() {
        if let Ok(current) = std::fs::read_to_string(&plist) {
            if let Ok((s, e)) = env_block_span(&current) {
                if let Ok(pairs) = parse_env_block(&current[s..e]) {
                    base = pairs;
                }
            }
        }
    }
    let merged = merge_enable_env(base, incoming);
    // The full plist is constructed here from resolved paths + merged env +
    // the explicit flag — no renderer XML is trusted over IPC.
    let (node, entry, _, log) = resolve_daemon_paths(&app)?;
    let xml = build_plist(&node, &entry, &log, &merged, run_at_load.unwrap_or(false));
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| friendly_io("create the LaunchAgents folder at", parent, &e))?;
    }
    if let Some(parent) = log_path()?.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| friendly_io("create the relay log folder at", parent, &e))?;
    }
    // 0600 from creation: the plist carries vault-copied tokens.
    write_plist_0600(&plist, &xml)?;

    // A stale loaded copy would shadow the new file; unload-then-load keeps
    // exactly one definition live (never hand-edit a loaded plist).
    let _ = launchctl(&app, &["unload", &plist.display().to_string()]).await;
    launchctl(&app, &["load", &plist.display().to_string()])
        .await
        .map_err(|e| {
            format!("The plist was written but the relay would not start — {e}")
        })?;
    match current_status(&app).await?.as_str() {
        "running" => Ok("The relay is installed and running.".to_string()),
        _ => Err("The plist was loaded but the relay process is not running yet — check the relay log.".to_string()),
    }
}

/// Flip RunAtLoad by rewriting the plist file and reloading the job
/// (rewrite-file + unload/load — never hand-edit a loaded plist).
#[tauri::command]
async fn daemon_set_boot(app: tauri::AppHandle, boot: bool) -> Result<String, String> {
    let plist = plist_path()?;
    let xml = std::fs::read_to_string(&plist)
        .map_err(|e| friendly_io("read the relay plist at", &plist, &e))?;
    let (from, to) = if boot {
        ("<key>RunAtLoad</key>\n\t<false/>", "<key>RunAtLoad</key>\n\t<true/>")
    } else {
        ("<key>RunAtLoad</key>\n\t<true/>", "<key>RunAtLoad</key>\n\t<false/>")
    };
    if !xml.contains(from) {
        return Err("Could not find the RunAtLoad switch in the relay plist — was it edited by hand? Re-enable the relay to rewrite it.".to_string());
    }
    let updated = xml.replacen(from, to, 1);
    write_plist_0600(&plist, &updated)?;
    if launchctl(&app, &["list", DAEMON_LABEL]).await.is_ok() {
        let arg = plist.display().to_string();
        launchctl(&app, &["unload", &arg]).await.map_err(|e| {
            format!("The boot setting was saved but the relay could not be reloaded — {e}")
        })?;
        launchctl(&app, &["load", &arg]).await.map_err(|e| {
            format!("The boot setting was saved but the relay could not be reloaded — {e}")
        })?;
    }
    if boot {
        Ok("The relay will now start when you log in.".to_string())
    } else {
        Ok("The relay will no longer start when you log in.".to_string())
    }
}

#[tauri::command]
async fn relay_log_tail(last_n: u32) -> Result<String, String> {
    let path = log_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| friendly_io("read the relay log at", &path, &e))?;
    let want = (last_n.max(1).min(2000)) as usize;
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(want);
    Ok(lines[start..].join("\n"))
}

// --- Plist EnvironmentVariables surgery -----------------------------------
// Escaping must match `escapeXml` in src/lib/daemon-plist.ts exactly.

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Render (key, value) pairs as the EnvironmentVariables dict contents
/// (leading newline + tab indent), same escaping as `buildPlist` in
/// `src/lib/daemon-plist.ts`. Callers pass sorted pairs.
fn render_env_block(pairs: &[(String, String)]) -> String {
    let mut block = String::from("\n");
    for (key, value) in pairs {
        block.push_str(&format!(
            "\t\t<key>{}</key>\n\t\t<string>{}</string>\n",
            escape_xml(key),
            escape_xml(value)
        ));
    }
    block.push_str("\t");
    block
}

/// Enable-time env merge (pure, unit-tested): (1) existing plist entries
/// preserved verbatim — raw values straight from the file, so non-vault
/// secrets with no vault source (`PROJECT_LOOKUP_TOKENS`,
/// `OBSERVABILITY_LOOKUP_TOKEN`) and user edits (`PROJECT_APP_BASES`,
/// custom `PORT`) survive reinstall; (2) vault-synced keys
/// (`VAULT_SYNCED_KEYS`) come ONLY from `incoming` (fresh vault re-sync —
/// a stale copy is dropped so a cleared vault value falls back to the
/// relay default); (3) the explicit enable patch is baked into `incoming`
/// last by the frontend, so it wins per key. Empty-string incoming values
/// delete the key (same as `relay_env_save`); the REDACTED sentinel is
/// skipped defensively (the frontend already strips it — a leaked sentinel
/// must never land in the file as a literal token). The `PORT` default is
/// inserted only when neither side sets it, so a user PORT edit is never
/// clobbered by the default.
fn merge_enable_env(
    existing: Vec<(String, String)>,
    incoming: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = existing
        .into_iter()
        .filter(|(k, _)| !VAULT_SYNCED_KEYS.contains(&k.as_str()))
        .collect();
    for (key, value) in incoming {
        if value == REDACTED {
            continue;
        }
        merged.retain(|(k, _)| *k != key);
        if !value.is_empty() {
            merged.push((key, value));
        }
    }
    if !merged.iter().any(|(k, _)| k == PORT_KEY) {
        merged.push((PORT_KEY.to_string(), PORT_DEFAULT.to_string()));
    }
    merged.sort_by(|a, b| a.0.cmp(&b.0));
    merged
}

/// Byte range of the EnvironmentVariables dict *contents* (between
/// `<dict>` and `</dict>`), so callers can parse or replace the block.
fn env_block_span(plist: &str) -> Result<(usize, usize), String> {
    let head = "<key>EnvironmentVariables</key>";
    let h = plist.find(head).ok_or_else(|| {
        "Could not find the EnvironmentVariables section in the relay plist — was it edited by hand? Re-enable the relay to rewrite it.".to_string()
    })?;
    let after_head = &plist[h + head.len()..];
    let dict_open = after_head.find("<dict>").ok_or_else(|| {
        "The EnvironmentVariables section is malformed — re-enable the relay to rewrite it.".to_string()
    })?;
    let content_start = h + head.len() + dict_open + "<dict>".len();
    let after_open = &plist[content_start..];
    let dict_close = after_open.find("</dict>").ok_or_else(|| {
        "The EnvironmentVariables section is malformed — re-enable the relay to rewrite it.".to_string()
    })?;
    Ok((content_start, content_start + dict_close))
}

/// Ordered (key, value) pairs from the env dict, XML entities decoded.
fn parse_env_block(block: &str) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    let mut rest = block;
    loop {
        let k_open = match rest.find("<key>") {
            Some(i) => i,
            None => break,
        };
        let k_close = rest[k_open..].find("</key>").ok_or_else(|| {
            "The EnvironmentVariables section is malformed — re-enable the relay to rewrite it.".to_string()
        })? + k_open;
        let key = rest[k_open + "<key>".len()..k_close].trim().to_string();
        let after_key = &rest[k_close + "</key>".len()..];
        let v_open = after_key.find("<string>").ok_or_else(|| {
            format!("The value for “{key}” is malformed — re-enable the relay to rewrite it.")
        })?;
        let v_close = after_key[v_open..].find("</string>").ok_or_else(|| {
            format!("The value for “{key}” is malformed — re-enable the relay to rewrite it.")
        })? + v_open;
        let value = unescape_xml(after_key[v_open + "<string>".len()..v_close].trim());
        pairs.push((key, value));
        rest = &after_key[v_close + "</string>".len()..];
    }
    Ok(pairs)
}

/// Names plus display values: secret values come back as REDACTED so tokens
/// never cross into UI state; everything else comes back verbatim.
#[tauri::command]
async fn relay_env_load() -> Result<HashMap<String, String>, String> {
    let plist = plist_path()?;
    let xml = std::fs::read_to_string(&plist)
        .map_err(|e| friendly_io("read the relay plist at", &plist, &e))?;
    let (start, end) = env_block_span(&xml)?;
    let mut env = HashMap::new();
    for (key, value) in parse_env_block(&xml[start..end])? {
        if SECRET_KEYS.contains(&key.as_str()) && !value.is_empty() {
            env.insert(key, REDACTED.to_string());
        } else {
            env.insert(key, value);
        }
    }
    Ok(env)
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    key.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Merge a patch into the plist env dict and rewrite the file (sorted keys,
/// same escaping as `buildPlist`). Empty-string values delete the key; the
/// REDACTED sentinel keeps the stored secret. The running relay only picks
/// this up on restart — the caller surfaces that hint, this command does
/// not reload the job.
#[tauri::command]
async fn relay_env_save(patch: HashMap<String, String>) -> Result<String, String> {
    for key in patch.keys() {
        if !valid_env_key(key) {
            return Err(format!("“{key}” is not a valid setting name — use letters, digits, and underscores."));
        }
    }
    for (key, value) in patch.iter() {
        if value.len() > 100_000 {
            return Err(format!("The value for “{key}” is too long (over 100 KB)."));
        }
    }
    let plist = plist_path()?;
    let xml = std::fs::read_to_string(&plist)
        .map_err(|e| friendly_io("read the relay plist at", &plist, &e))?;
    let (start, end) = env_block_span(&xml)?;
    let mut pairs = parse_env_block(&xml[start..end])?;
    for (key, value) in patch {
        if value == REDACTED {
            continue;
        }
        pairs.retain(|(k, _)| *k != key);
        if !value.is_empty() {
            pairs.push((key, value));
        }
    }
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let updated = format!("{}{}{}", &xml[..start], render_env_block(&pairs), &xml[end..]);
    write_plist_0600(&plist, &updated)?;
    Ok("Relay settings saved. Disable then Enable the relay for them to take effect.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_parses_running_row() {
        let out = "PID\tStatus\tLabel\n1234\t0\tdev.ctimothe.glitchtip-onboarding.relay\n";
        assert_eq!(pid_from_list_output(out), Some(Some(1234)));
    }

    #[test]
    fn pid_dash_means_loaded_without_process() {
        let out = "PID\tStatus\tLabel\n-\t0\tdev.ctimothe.glitchtip-onboarding.relay\n";
        assert_eq!(pid_from_list_output(out), Some(None));
    }

    #[test]
    fn pid_missing_label_means_not_loaded() {
        let out = "PID\tStatus\tLabel\n1234\t0\tcom.other.job\n";
        assert_eq!(pid_from_list_output(out), None);
    }

    #[test]
    fn env_round_trips_through_escape() {
        let pairs = vec![("PORT".to_string(), "8090".to_string())];
        let mut block = String::from("\n");
        for (k, v) in &pairs {
            block.push_str(&format!(
                "\t\t<key>{}</key>\n\t\t<string>{}</string>\n",
                escape_xml(k),
                escape_xml(v)
            ));
        }
        assert_eq!(
            parse_env_block(&block).unwrap(),
            vec![("PORT".to_string(), "8090".to_string())]
        );
    }

    #[test]
    fn env_special_chars_survive() {
        let raw = "{\"a\":\"<x>&\\\"y\\\"\"}";
        let block = format!("\n\t\t<key>K</key>\n\t\t<string>{}</string>\n", escape_xml(raw));
        assert_eq!(parse_env_block(&block).unwrap()[0].1, raw);
    }

    #[test]
    fn env_key_validation() {
        assert!(valid_env_key("PORT"));
        assert!(valid_env_key("_PRIVATE_1"));
        assert!(!valid_env_key("has space"));
        assert!(!valid_env_key("9LIVES"));
        assert!(!valid_env_key(""));
        assert!(!valid_env_key("DASH-ED"));
    }

    fn pair(key: &str, value: &str) -> (String, String) {
        (key.to_string(), value.to_string())
    }

    #[test]
    fn enable_merge_preserves_non_vault_keys_verbatim() {
        // Reinstall over a plist holding user non-vault keys: raw lookup
        // tokens (no vault source — the redacted display value must never
        // feed this path), map edits, and a custom PORT all survive.
        let base = vec![
            pair("PROJECT_LOOKUP_TOKENS", "{\"p\":\"tok-<>&\\\"\"}"),
            pair("OBSERVABILITY_LOOKUP_TOKEN", "obs-token"),
            pair("PROJECT_APP_BASES", "{\"a\":1}"),
            pair("PORT", "9000"),
        ];
        let incoming = vec![pair("TELEGRAM_ALERT_BOT_TOKEN", "fresh")];
        let merged = merge_enable_env(base, incoming);
        assert!(merged.contains(&pair("PROJECT_LOOKUP_TOKENS", "{\"p\":\"tok-<>&\\\"\"}")));
        assert!(merged.contains(&pair("OBSERVABILITY_LOOKUP_TOKEN", "obs-token")));
        assert!(merged.contains(&pair("PROJECT_APP_BASES", "{\"a\":1}")));
        // Custom PORT kept — the default must not clobber it.
        assert!(merged.contains(&pair("PORT", "9000")));
        assert!(merged.contains(&pair("TELEGRAM_ALERT_BOT_TOKEN", "fresh")));
    }

    #[test]
    fn enable_merge_vault_resync_overwrites_and_purges_stale() {
        let base = vec![
            pair("GLITCHTIP_API_TOKEN", "stale"),
            pair("DEFAULT_PROJECT", "old-project"),
        ];
        let incoming = vec![pair("GLITCHTIP_API_TOKEN", "fresh")];
        let merged = merge_enable_env(base, incoming);
        // Fresh vault value overwrites the stale one …
        assert!(merged.contains(&pair("GLITCHTIP_API_TOKEN", "fresh")));
        // … and a vault-synced key absent from the re-sync is dropped
        // (relay default applies) rather than resurrected from the file.
        assert!(!merged.iter().any(|(k, _)| k == "DEFAULT_PROJECT"));
    }

    #[test]
    fn enable_merge_explicit_patch_wins_and_empty_deletes() {
        let base = vec![
            pair("PROJECT_APP_BASES", "{\"a\":1}"),
            pair("LOG_PAYLOAD", "1"),
        ];
        let incoming = vec![
            pair("PROJECT_APP_BASES", "{\"b\":2}"),
            pair("LOG_PAYLOAD", ""),
        ];
        let merged = merge_enable_env(base, incoming);
        // Explicit patch (baked into incoming last) wins …
        assert!(merged.contains(&pair("PROJECT_APP_BASES", "{\"b\":2}")));
        // … and empty-string patch values delete the key.
        assert!(!merged.iter().any(|(k, _)| k == "LOG_PAYLOAD"));
        // No PORT anywhere → default inserted.
        assert!(merged.contains(&pair("PORT", "8090")));
    }

    #[test]
    fn enable_merge_fresh_install_gets_port_default_sorted() {
        let merged = merge_enable_env(vec![], vec![pair("GLITCHTIP_API_BASE", "https://x")]);
        assert!(merged.contains(&pair("PORT", "8090")));
        let keys: Vec<&str> = merged.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["GLITCHTIP_API_BASE", "PORT"]);
    }

    #[test]
    fn enable_merge_redacted_sentinel_never_lands_in_file() {
        // The frontend strips REDACTED before sending, but a leaked sentinel
        // must not land in the plist as a literal token: non-vault keys keep
        // their stored value, vault keys fall back to the relay default.
        let base = vec![
            pair("PROJECT_LOOKUP_TOKENS", "real-tokens"),
            pair("GLITCHTIP_API_TOKEN", "stale"),
        ];
        let incoming = vec![
            pair("PROJECT_LOOKUP_TOKENS", REDACTED),
            pair("GLITCHTIP_API_TOKEN", REDACTED),
        ];
        let merged = merge_enable_env(base, incoming);
        assert!(merged.contains(&pair("PROJECT_LOOKUP_TOKENS", "real-tokens")));
        assert!(!merged.iter().any(|(k, _)| k == "GLITCHTIP_API_TOKEN"));
        assert!(!merged.iter().any(|(_, v)| v == REDACTED));
    }

    #[test]
    fn build_plist_pins_full_xml_like_frontend_fixture() {
        // Mirrors daemon-plist.test.ts EXPECTED: same key order, sorted env,
        // same escaping, RunAtLoad false at install. The renderer never
        // supplies XML — this constructor is the only install-plist author.
        let env = vec![
            (
                "PROJECT_APP_BASES".to_string(),
                "{\"my-project\":{\"production\":\"https://app.example.com\"}}".to_string(),
            ),
            (
                "GLITCHTIP_API_BASE".to_string(),
                "https://glitchtip.example.com".to_string(),
            ),
            ("PORT".to_string(), "8090".to_string()),
        ];
        let xml = build_plist(
            "/Applications/GlitchTip Onboarding.app/Contents/MacOS/binaries/node",
            "/Applications/GlitchTip Onboarding.app/Contents/Resources/_up_/_up_/_up_/assets/relay/server.js",
            "/Users/someone/Library/Logs/dev.ctimothe.glitchtip-onboarding/relay.log",
            &env,
            false,
        );
        let expected = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
            <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
            <plist version=\"1.0\">\n\
            <dict>\n\
            \t<key>Label</key>\n\
            \t<string>dev.ctimothe.glitchtip-onboarding.relay</string>\n\
            \t<key>ProgramArguments</key>\n\
            \t<array>\n\
            \t\t<string>/Applications/GlitchTip Onboarding.app/Contents/MacOS/binaries/node</string>\n\
            \t\t<string>/Applications/GlitchTip Onboarding.app/Contents/Resources/_up_/_up_/_up_/assets/relay/server.js</string>\n\
            \t</array>\n\
            \t<key>EnvironmentVariables</key>\n\
            \t<dict>\n\
            \t\t<key>GLITCHTIP_API_BASE</key>\n\
            \t\t<string>https://glitchtip.example.com</string>\n\
            \t\t<key>PORT</key>\n\
            \t\t<string>8090</string>\n\
            \t\t<key>PROJECT_APP_BASES</key>\n\
            \t\t<string>{&quot;my-project&quot;:{&quot;production&quot;:&quot;https://app.example.com&quot;}}</string>\n\
            \t</dict>\n\
            \t<key>RunAtLoad</key>\n\
            \t<false/>\n\
            \t<key>KeepAlive</key>\n\
            \t<true/>\n\
            \t<key>StandardOutPath</key>\n\
            \t<string>/Users/someone/Library/Logs/dev.ctimothe.glitchtip-onboarding/relay.log</string>\n\
            \t<key>StandardErrorPath</key>\n\
            \t<string>/Users/someone/Library/Logs/dev.ctimothe.glitchtip-onboarding/relay.log</string>\n\
            </dict>\n\
            </plist>\n";
        assert_eq!(xml, expected);
    }

    #[test]
    fn build_plist_escapes_and_honors_run_at_load() {
        let env = vec![("K".to_string(), "{\"a\":\"<x>&\\\"y\\\"\"}".to_string())];
        let xml = build_plist("/tmp/a&b/node", "/entry", "/log", &env, true);
        assert!(xml.contains("<string>/tmp/a&amp;b/node</string>"));
        assert!(xml.contains(
            "<string>{&quot;a&quot;:&quot;&lt;x&gt;&amp;\\&quot;y\\&quot;&quot;}</string>"
        ));
        assert!(xml.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(!xml.contains("a&b"));
    }

    #[test]
    fn run_at_load_parses_switch() {
        let mk = |flag: &str| {
            format!("<dict>\n\t<key>RunAtLoad</key>\n\t{flag}\n\t<key>KeepAlive</key>\n</dict>")
        };
        assert_eq!(parse_run_at_load(&mk("<true/>")), Ok(true));
        assert_eq!(parse_run_at_load(&mk("<false/>")), Ok(false));
        assert!(parse_run_at_load("<dict>\n</dict>").is_err());
        assert!(parse_run_at_load("<dict>\n\t<key>RunAtLoad</key>\n\t<maybe/>\n</dict>").is_err());
    }

    #[test]
    fn status_detail_running_carries_pid() {
        let out = "PID\tStatus\tLabel\n4242\t0\tdev.ctimothe.glitchtip-onboarding.relay\n";
        assert_eq!(
            status_detail_parts(true, Ok(out)),
            ("running".to_string(), Some(4242))
        );
    }

    #[test]
    fn status_detail_loaded_without_pid_is_stopped() {
        let out = "PID\tStatus\tLabel\n-\t0\tdev.ctimothe.glitchtip-onboarding.relay\n";
        assert_eq!(
            status_detail_parts(true, Ok(out)),
            ("stopped".to_string(), None)
        );
    }

    #[test]
    fn status_detail_launchctl_error_is_stopped() {
        assert_eq!(
            status_detail_parts(true, Err(())),
            ("stopped".to_string(), None)
        );
    }

    #[test]
    fn write_plist_enforces_0600_on_preexisting_lax_file() {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "plist-0600-test-{}-{}.plist",
            std::process::id(),
            "lax"
        ));
        // Pre-existing lax file (umask drift / restore / hand-chmod).
        {
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o644)
                .open(&path)
                .unwrap();
            f.write_all(b"old").unwrap();
        }
        // Force lax bits even under a restrictive umask.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_plist_0600(&path, "new").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn status_detail_missing_plist_is_not_installed() {
        assert_eq!(
            status_detail_parts(false, Err(())),
            ("not-installed".to_string(), None)
        );
        // Even a running-looking output cannot outrank a missing plist.
        let out = "PID\tStatus\tLabel\n1\t0\tdev.ctimothe.glitchtip-onboarding.relay\n";
        assert_eq!(
            status_detail_parts(false, Ok(out)),
            ("not-installed".to_string(), None)
        );
    }
}

// --- Menubar ticker (v2 Task 4) -------------------------------------------
// The tray icon is Rust-owned so `icons/tray.png` (a template image drawn from
// `icons/tray.svg`) ships inside the binary (no resource-path lookup, no extra
// capability scopes); macOS tints it for light and dark menu bars. The
// frontend owns the alert feed: `TrayManager.tsx` polls the relay log every
// 10 s and pushes tooltip/badge/menu through `tray_update`. No desktop
// notifications in v1 (the notification plugin is present but unconfigured
// — explicit non-goal).

const TRAY_ID: &str = "main";
const TRAY_OPEN_ID: &str = "tray-open";
const TRAY_QUIT_ID: &str = "tray-quit";

#[derive(serde::Deserialize)]
struct TrayAlertItem {
    id: String,
    text: String,
}

/// The menu's fixed rows, in the workspace's language (the renderer owns translations).
#[derive(serde::Deserialize)]
struct TrayLabels {
    empty: String,
    open: String,
    quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            empty: "No alerts yet".into(),
            open: "Open GlitchTip Companion".into(),
            quit: "Quit GlitchTip Companion".into(),
        }
    }
}

/// Rebuild the tray dropdown: the latest delivered alerts (disabled rows —
/// chosen for reading, not clicking), then Open and Quit.
fn build_tray_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    alerts: &[TrayAlertItem],
    labels: &TrayLabels,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if alerts.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "tray-empty",
            labels.empty.as_str(),
            false,
            None::<&str>,
        )?)?;
    } else {
        for item in alerts {
            menu.append(&MenuItem::with_id(
                app,
                item.id.as_str(),
                item.text.as_str(),
                false,
                None::<&str>,
            )?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        TRAY_OPEN_ID,
        labels.open.as_str(),
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        TRAY_QUIT_ID,
        labels.quit.as_str(),
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Push ticker state into the menubar icon. `title` is the unread badge
/// (None clears it); `alerts` are the latest-first menu rows assembled by
/// the frontend (at most 5) and `labels` its fixed rows. Every failure is plain English.
#[tauri::command]
async fn tray_update(
    app: tauri::AppHandle,
    tooltip: String,
    title: Option<String>,
    alerts: Vec<TrayAlertItem>,
    labels: TrayLabels,
) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "The menubar icon is not available.".to_string())?;
    let menu = build_tray_menu(&app, &alerts, &labels)
        .map_err(|e| format!("Could not rebuild the menubar menu — {e}."))?;
    tray.set_menu(Some(menu))
        .map_err(|e| format!("Could not update the menubar menu — {e}."))?;
    tray.set_tooltip(Some(tooltip))
        .map_err(|e| format!("Could not update the menubar tooltip — {e}."))?;
    tray.set_title(title)
        .map_err(|e| format!("Could not update the menubar badge — {e}."))?;
    Ok(())
}

fn main() {
    // Started by the agent helper launcher: answer the context request and exit, with no window.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some(helper::LAUNCH_FLAG) {
        std::process::exit(helper::main(&args[1..]));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .menu(|app| app_menu::build(app, &app_menu::AppMenuLabels::default(), false))
        .on_menu_event(|app, event| app_menu::on_event(app, event.id.as_ref()))
        .setup(|app| {
            let menu = build_tray_menu(app.handle(), &[], &TrayLabels::default())?;
            let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .icon_as_template(true)
                .tooltip("GlitchTip Companion")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    TRAY_OPEN_ID => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    TRAY_QUIT_ID => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_status_detail,
            daemon_paths,
            daemon_get_boot,
            daemon_set_enabled,
            daemon_set_boot,
            relay_log_tail,
            relay_env_load,
            relay_env_save,
            tray_update,
            app_menu::app_menu_update,
            keychain::secret_set,
            keychain::secret_get,
            keychain::secret_remove,
            keychain::secret_presence,
            keychain::secret_migrate_file_vault,
            keychain::secret_remove_file_vault,
            remote::server_preflight,
            remote::deployment_preview,
            remote::deploy_relay,
            remote::relay_status,
            remote::relay_audit_tail,
            remote::rollback_relay,
            remote::relay_control,
            agent_install::agent_install_preview,
            agent_install::agent_install,
            agent_install::agent_verify
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
