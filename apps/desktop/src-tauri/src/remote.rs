// Validated SSH preflight and transactional relay deployment.
//
// Only `/usr/bin/ssh` and `/usr/bin/scp` are ever run, with argv vectors and
// fixed scripts on stdin: no shell on the Mac. Remote values reach the remote
// shell single-quoted after validation. Process execution sits behind
// `Runner` so validation, argv, preview, script and rollback logic are unit
// tested with a fake. Every command returns `Err(code)`; no token ever
// appears in an argv, preview, result or error. The relay env text is read
// from the Keychain (`relay.env` under the workspace, written by
// src/lib/relay-config.ts) and written only to a 0600 file in a temporary
// directory.

use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

pub const SSH: &str = "/usr/bin/ssh";
pub const SCP: &str = "/usr/bin/scp";
const PROJECT: &str = "glitchtip-companion";
const BASE: &str = ".local/share/glitchtip-companion";
const ENV_KEY: &str = "relay.env";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerRequest {
    pub host: String,
    pub user: String,
    pub port: u32,
    pub identity_file: String,
    pub docker_network: String,
    pub deployment_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployRequest {
    #[serde(flatten)]
    pub server: ServerRequest,
    pub workspace_id: String,
    pub application_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditRequest {
    #[serde(flatten)]
    pub server: ServerRequest,
    pub lines: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    #[serde(flatten)]
    pub server: ServerRequest,
    pub to_revision: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Check {
    pub id: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerPreflight {
    pub ok: bool,
    pub checks: Vec<Check>,
    pub existing_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PreviewFile {
    pub path: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentPreview {
    pub revision: String,
    pub previous_revision: Option<String>,
    pub files: Vec<PreviewFile>,
    pub compose_services: Vec<String>,
    pub published_ports: Vec<u16>,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentResult {
    pub ok: bool,
    pub revision: String,
    pub previous_revision: Option<String>,
    pub failed_step: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub reachable: bool,
    pub healthy: bool,
    pub revision: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RelayCommand {
    PairingCreate,
    PairingStatus,
    TopicCreate { name: String, color: u32 },
    #[serde(rename_all = "camelCase")]
    SendTest { application_id: String },
    #[serde(rename_all = "camelCase")]
    SendSetupComplete { application_id: String },
    AuditTail { lines: u32 },
}

// --- Process runner ----------------------------------------------------------

pub struct Output {
    pub success: bool,
    pub stdout: String,
}

pub trait Runner {
    /// Run `program` (only SSH or SCP) with `args` and `stdin`.
    fn run(&self, program: &str, args: &[String], stdin: &[u8]) -> Result<Output, String>;
    fn is_file(&self, path: &str) -> bool;
}

pub struct SystemRunner;

impl Runner for SystemRunner {
    fn run(&self, program: &str, args: &[String], stdin: &[u8]) -> Result<Output, String> {
        if program != SSH && program != SCP {
            return Err("ssh-unavailable".into());
        }
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "ssh-unavailable".to_string())?;
        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(stdin);
        }
        let output = child.wait_with_output().map_err(|_| "ssh-failed".to_string())?;
        Ok(Output {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        })
    }

    fn is_file(&self, path: &str) -> bool {
        Path::new(path).is_file()
    }
}

// --- Validation --------------------------------------------------------------

fn clean_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':'))
}

fn valid_deployment_dir(dir: &str) -> bool {
    if dir.contains("..") || dir.contains("//") || !dir.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b'$')) {
        return false;
    }
    let rest = if let Some(rest) = dir.strip_prefix("$HOME/") {
        rest
    } else if let Some(rest) = dir.strip_prefix('/') {
        // Absolute: `/<home...>/.local/share/glitchtip-companion[/sub]`.
        match rest.find(BASE) {
            Some(at) if at > 0 && rest.as_bytes()[at - 1] == b'/' && !rest[..at].contains('$') => &rest[at..],
            _ => return false,
        }
    } else {
        return false;
    };
    rest == BASE || rest.strip_prefix(BASE).is_some_and(|tail| tail.starts_with('/') && !tail.contains('$'))
}

pub fn validate(request: &ServerRequest, runner: &dyn Runner) -> Result<(), &'static str> {
    if !clean_token(&request.host, 253) {
        return Err("invalid-host");
    }
    if !clean_token(&request.user, 64) {
        return Err("invalid-user");
    }
    if !(1..=65535).contains(&request.port) {
        return Err("invalid-port");
    }
    // An empty identity file means ssh's default identities (agent or ~/.ssh/id_*); a given
    // path must exist as a file.
    if request.identity_file.chars().any(|c| c.is_control())
        || (!request.identity_file.is_empty() && !runner.is_file(&request.identity_file))
    {
        return Err("invalid-identity-file");
    }
    if !clean_token(&request.docker_network, 64) {
        return Err("invalid-network");
    }
    if !valid_deployment_dir(&request.deployment_dir) {
        return Err("invalid-deployment-dir");
    }
    Ok(())
}

fn valid_revision(revision: &str) -> bool {
    revision.len() == 16 && revision.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_application_id(id: &str) -> bool {
    clean_token(id, 64)
}

// --- Argv --------------------------------------------------------------------

fn common_options(request: &ServerRequest) -> Vec<String> {
    let mut options: Vec<String> = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if !request.identity_file.is_empty() {
        options.extend(["-i".to_string(), request.identity_file.clone()]);
    }
    options
}

pub fn ssh_args(request: &ServerRequest, remote: &[&str]) -> Vec<String> {
    let mut args = common_options(request);
    args.extend(["-p".to_string(), request.port.to_string(), format!("{}@{}", request.user, request.host)]);
    args.extend(remote.iter().map(|s| s.to_string()));
    args
}

pub fn scp_args(request: &ServerRequest, local: &str, remote_path: &str) -> Vec<String> {
    let mut args = common_options(request);
    args.extend([
        "-P".to_string(),
        request.port.to_string(),
        "-r".to_string(),
        local.to_string(),
        format!("{}@{}:{}", request.user, request.host, remote_path),
    ]);
    args
}

/// scp resolves relative paths from the remote home; it does not expand `$HOME`.
fn scp_path(dir: &str) -> String {
    dir.strip_prefix("$HOME/").unwrap_or(dir).to_string()
}

fn sq(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// --- Scripts -----------------------------------------------------------------

pub const PREFLIGHT_SCRIPT: &str = r#"set -u
dir="$2"; net="$3"
check() { printf 'CHECK %s %s %s\n' "$1" "$2" "$3"; }
check host-key ok "known host"
if [ "$(uname -s)" = Linux ]; then check linux ok "$(uname -sr)"; else check linux fail "$(uname -s)"; fi
check architecture ok "$(uname -m)"
if v=$(docker --version 2>/dev/null); then check docker ok "$v"; else check docker fail "docker missing"; fi
if v=$(docker compose version --short 2>/dev/null); then
  major=${v#v}; major=${major%%.*}
  case "$major" in ''|*[!0-9]*) check compose fail "$v";; *) if [ "$major" -ge 2 ]; then check compose ok "$v"; else check compose fail "$v"; fi;; esac
else check compose fail "docker compose missing"; fi
if docker info >/dev/null 2>&1; then check daemon ok "docker daemon reachable"; else check daemon fail "docker daemon not accessible"; fi
avail=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $4}')
if [ "${avail:-0}" -ge 1048576 ]; then check disk ok "${avail} KB free"; else check disk fail "${avail:-0} KB free, need 1048576"; fi
if docker network inspect "$net" >/dev/null 2>&1; then check network ok "$net"; else check network fail "$net not found"; fi
# GlitchTip reaches the relay by name on this network, and since GlitchTip 6.1.7 it sends webhooks
# to a private address such as the relay's only with GLITCHTIP_ALLOW_PRIVATE_IPS on. A container is
# GlitchTip by its image name or, for a renamed or private image, by GlitchTip's GLITCHTIP_DOMAIN
# setting. Of each environment only those two variables are used, and nothing of it is printed.
found=0; blocked=0
for c in $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net" 2>/dev/null); do
  image=$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null)
  case "$image" in *glitchtip-companion*) continue;; esac
  env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" 2>/dev/null)
  case "$image" in *glitchtip*) ;; *) printf '%s\n' "$env" | grep -q '^GLITCHTIP_DOMAIN=' || continue;; esac
  found=$((found + 1))
  allow=$(printf '%s\n' "$env" | sed -n 's/^GLITCHTIP_ALLOW_PRIVATE_IPS=//p' | tr '[:upper:]' '[:lower:]')
  case "$allow" in true|on|ok|y|yes|1) ;; *) blocked=$((blocked + 1));; esac
done
if [ "$found" -eq 0 ]; then check glitchtip-network fail "no GlitchTip container on $net"
else
  check glitchtip-network ok "$found GlitchTip containers on $net"
  if [ "$blocked" -eq 0 ]; then check glitchtip-webhooks ok "private webhooks allowed"; else check glitchtip-webhooks fail "GLITCHTIP_ALLOW_PRIVATE_IPS off in $blocked of $found"; fi
fi
if mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then check deployment-dir ok "$dir"; else check deployment-dir fail "$dir not writable"; fi
rev=$(basename "$(readlink "$dir/current" 2>/dev/null)" 2>/dev/null)
printf 'REVISION %s\n' "$rev"
"#;

/// Fixed installer. Args: install <dir> <revision> <network>. Any failed proof,
/// or a hangup or termination (a dropped SSH session), restores `current`, the
/// previous `relay.env` and the previous release's container (a first install
/// is stopped and its `relay.env` removed instead), keeps the failed release
/// for diagnosis and prints `FAILED <step>`. Each release builds its own image
/// tag, so a restore or rollback runs that release's code. `current` and
/// `previous` move only once the new release is proven, with signals held.
/// Redeploying the running release only replaces its environment: the
/// release stays, and it never becomes its own rollback target.
pub const INSTALL_SCRIPT: &str = r#"set -u
mode="$1"; dir="$2"; rev="$3"; net="${4:-glitchtip}"
project=glitchtip-companion
export COMPANION_DOCKER_NETWORK="$net"
fail() { printf 'FAILED %s\n' "$1"; restore; exit 1; }
prev=$(basename "$(readlink "$dir/current" 2>/dev/null)" 2>/dev/null)
env_saved=
restore() {
  trap '' HUP INT TERM
  [ -n "$env_saved" ] && mv -f "$dir/shared/relay.env.prev" "$dir/shared/relay.env"
  if [ -n "$prev" ] && [ -d "$dir/releases/$prev" ]; then
    ln -sfn "$dir/releases/$prev" "$dir/current"
    up "$prev" up -d >/dev/null 2>&1
  elif [ "$mode" = install ]; then
    [ -f "$dir/releases/$rev/deploy/compose.yaml" ] && up "$rev" down >/dev/null 2>&1
    [ -z "$env_saved" ] && rm -f "$dir/shared/relay.env"
  fi
}
up() { COMPANION_RELEASE="$1" docker compose -p "$project" -f "$dir/releases/$1/deploy/compose.yaml" "${@:2}"; }
# A dropped SSH session must not leave a half-installed relay: restore instead,
# and keep going when the output pipe is gone.
trap 'fail interrupted' HUP INT TERM
trap '' PIPE
case "$mode" in
install)
  [ -d "$dir/incoming-$rev" ] || fail stage
  mkdir -p "$dir/releases" "$dir/shared" || fail stage
  if [ -f "$dir/shared/relay.env" ]; then cp -p "$dir/shared/relay.env" "$dir/shared/relay.env.prev" || fail stage; env_saved=1; fi
  if [ "$rev" = "$prev" ] && [ -d "$dir/releases/$rev" ]; then rm -rf "$dir/incoming-$rev/bundle"
  else rm -rf "$dir/releases/$rev"; mv "$dir/incoming-$rev/bundle" "$dir/releases/$rev" || fail stage; fi
  mv "$dir/incoming-$rev/relay.env" "$dir/shared/relay.env" || fail stage
  chmod 600 "$dir/shared/relay.env"; rm -rf "$dir/incoming-$rev"
  ln -sfn "$dir/shared/relay.env" "$dir/releases/$rev/deploy/relay.env"
  up "$rev" config >/dev/null || fail config
  up "$rev" build || fail build
  up "$rev" up -d || fail start
  n=0; until [ "$(up "$rev" ps --format '{{.Health}}' 2>/dev/null | head -1)" = healthy ]; do n=$((n+1)); [ $n -gt 40 ] && fail readiness; sleep 3; done
  up "$rev" exec -T companion-relay node control.js audit-tail --lines 1 >/dev/null || fail synthetic-event
  trap '' HUP INT TERM
  ln -sfn "$dir/releases/$rev" "$dir/current" || fail switch
  [ -n "$prev" ] && [ "$prev" != "$rev" ] && ln -sfn "$dir/releases/$prev" "$dir/previous"
  rm -f "$dir/shared/relay.env.prev"
  printf 'OK %s\n' "$rev" ;;
rollback)
  [ -d "$dir/releases/$rev" ] || fail missing-release
  ln -sfn "$dir/releases/$rev" "$dir/current"
  up "$rev" up -d || fail start
  printf 'OK %s\n' "$rev" ;;
status)
  cur=$(basename "$(readlink "$dir/current" 2>/dev/null)" 2>/dev/null)
  printf 'REVISION %s\nHEALTH %s\n' "$cur" "$(docker compose -p "$project" -f "$dir/current/deploy/compose.yaml" ps --format '{{.Health}}' 2>/dev/null | head -1)" ;;
releases)
  ls -1 "$dir/releases" 2>/dev/null ;;
*) exit 2 ;;
esac
"#;

// --- Bundle, revision and preview --------------------------------------------

pub struct BundleFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// Every file under `<assets/relay>`, excluding tests, relative `/` paths, sorted.
pub fn collect_bundle(root: &Path) -> Result<Vec<BundleFile>, String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<BundleFile>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|_| "bundle-unreadable".to_string())? {
            let path = entry.map_err(|_| "bundle-unreadable".to_string())?.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if path.is_dir() {
                if name != "fixtures" {
                    walk(root, &path, out)?;
                }
            } else if !name.ends_with(".test.js") && name != "relay.env" {
                let rel = path.strip_prefix(root).map_err(|_| "bundle-unreadable".to_string())?;
                let bytes = std::fs::read(&path).map_err(|_| "bundle-unreadable".to_string())?;
                out.push(BundleFile { path: rel.to_string_lossy().replace('\\', "/"), bytes });
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

/// Stable 16-hex-digit FNV-1a revision over file names and contents.
pub fn revision_of(files: &[BundleFile]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for file in files {
        for byte in file.path.bytes().chain([0]).chain(file.bytes.iter().copied()).chain([0]) {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    format!("{hash:016x}")
}

pub fn parse_revision_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|l| l.strip_prefix("REVISION "))
        .map(str::trim)
        .filter(|r| valid_revision(r))
        .map(String::from)
}

pub fn build_preview(request: &ServerRequest, files: &[BundleFile], previous: Option<String>) -> DeploymentPreview {
    let revision = revision_of(files);
    let dir = &request.deployment_dir;
    let mut listed: Vec<PreviewFile> = files
        .iter()
        .map(|f| PreviewFile { path: format!("{dir}/releases/{revision}/{}", f.path), mode: "0644".into() })
        .collect();
    listed.push(PreviewFile { path: format!("{dir}/shared/relay.env"), mode: "0600".into() });
    DeploymentPreview {
        revision: revision.clone(),
        previous_revision: previous,
        files: listed,
        compose_services: vec!["companion-relay".into()],
        // The relay publishes no host port; it joins the external network only.
        published_ports: vec![],
        commands: vec![
            format!("scp -r <bundle> {}@{}:{dir}/incoming-{revision}", request.user, request.host),
            format!("ssh {}@{} bash -s -- install {dir} {revision}", request.user, request.host),
        ],
    }
}

/// Rollback is allowed only to an existing release other than the current one.
pub fn decide_rollback(current: Option<&str>, target: &str, releases: &[String]) -> Result<(), &'static str> {
    if !valid_revision(target) {
        return Err("invalid-revision");
    }
    if current == Some(target) {
        return Err("already-current");
    }
    if !releases.iter().any(|r| r == target) {
        return Err("unknown-revision");
    }
    Ok(())
}

// --- Operations --------------------------------------------------------------

fn ssh_script(
    runner: &dyn Runner,
    request: &ServerRequest,
    script: &str,
    args: &[&str],
) -> Result<Output, String> {
    let mut remote: Vec<&str> = vec!["bash", "-s", "--"];
    remote.extend(args);
    runner.run(SSH, &ssh_args(request, &remote), script.as_bytes())
}

pub fn run_preflight(runner: &dyn Runner, request: &ServerRequest) -> Result<ServerPreflight, String> {
    validate(request, runner).map_err(String::from)?;
    let out = ssh_script(runner, request, PREFLIGHT_SCRIPT, &["preflight", &request.deployment_dir, &request.docker_network])?;
    let mut checks: Vec<Check> = out
        .stdout
        .lines()
        .filter_map(|l| l.strip_prefix("CHECK "))
        .filter_map(|l| {
            let mut parts = l.splitn(3, ' ');
            Some(Check { id: parts.next()?.into(), ok: parts.next()? == "ok", detail: parts.next().unwrap_or("").into() })
        })
        .collect();
    if !out.success && checks.is_empty() {
        checks.push(Check { id: "host-key".into(), ok: false, detail: "ssh connection or host key check failed".into() });
    }
    Ok(ServerPreflight {
        ok: out.success && !checks.is_empty() && checks.iter().all(|c| c.ok),
        checks,
        existing_revision: parse_revision_line(&out.stdout),
    })
}

pub fn run_preview(runner: &dyn Runner, request: &DeployRequest, bundle: &Path) -> Result<DeploymentPreview, String> {
    validate(&request.server, runner).map_err(String::from)?;
    let files = collect_bundle(bundle)?;
    let previous = existing_revision(runner, &request.server)?;
    Ok(build_preview(&request.server, &files, previous))
}

fn existing_revision(runner: &dyn Runner, server: &ServerRequest) -> Result<Option<String>, String> {
    let out = ssh_script(runner, server, INSTALL_SCRIPT, &["status", &server.deployment_dir, "-", &server.docker_network])?;
    Ok(parse_revision_line(&out.stdout))
}

fn step_result(out: &Output, revision: String, previous: Option<String>) -> DeploymentResult {
    let failed = out.stdout.lines().find_map(|l| l.strip_prefix("FAILED ")).map(|s| s.trim().to_string());
    let ok = out.success && failed.is_none() && out.stdout.lines().any(|l| l == format!("OK {revision}"));
    DeploymentResult { ok, revision, previous_revision: previous, failed_step: if ok { None } else { Some(failed.unwrap_or_else(|| "install".into())) } }
}

pub fn run_deploy(
    runner: &dyn Runner,
    request: &DeployRequest,
    bundle: &Path,
    env_text: &str,
) -> Result<DeploymentResult, String> {
    validate(&request.server, runner).map_err(String::from)?;
    // The first deploy runs before Telegram is paired, so it has no applications yet.
    if !request.application_ids.iter().all(|id| valid_application_id(id)) {
        return Err("invalid-application-id".into());
    }
    let files = collect_bundle(bundle)?;
    let revision = revision_of(&files);
    let previous = existing_revision(runner, &request.server)?;
    let server = &request.server;

    let staging = tempfile::tempdir().map_err(|_| "staging-failed".to_string())?;
    let root = staging.path().join(format!("incoming-{revision}"));
    for file in &files {
        let target = root.join("bundle").join(&file.path);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|_| "staging-failed".to_string())?;
        std::fs::write(&target, &file.bytes).map_err(|_| "staging-failed".to_string())?;
    }
    let env_path = root.join("relay.env");
    std::fs::write(&env_path, env_text).map_err(|_| "staging-failed".to_string())?;
    std::fs::set_permissions(&env_path, std::fs::Permissions::from_mode(0o600)).map_err(|_| "staging-failed".to_string())?;

    let dest = scp_path(&server.deployment_dir);
    let ready = ssh_script(runner, server, "mkdir -p \"$2\"", &["mkdir", &server.deployment_dir])?;
    if !ready.success {
        return Ok(DeploymentResult { ok: false, revision, previous_revision: previous, failed_step: Some("stage".into()) });
    }
    let copied = runner.run(SCP, &scp_args(server, &root.to_string_lossy(), &dest), b"")?;
    if !copied.success {
        return Ok(DeploymentResult { ok: false, revision, previous_revision: previous, failed_step: Some("transfer".into()) });
    }
    let out = ssh_script(runner, server, INSTALL_SCRIPT, &["install", &server.deployment_dir, &revision, &server.docker_network])?;
    Ok(step_result(&out, revision, previous))
}

pub fn run_status(runner: &dyn Runner, request: &ServerRequest) -> Result<RelayStatus, String> {
    validate(request, runner).map_err(String::from)?;
    match ssh_script(runner, request, INSTALL_SCRIPT, &["status", &request.deployment_dir, "-", &request.docker_network]) {
        Ok(out) if out.success => {
            let health = out.stdout.lines().find_map(|l| l.strip_prefix("HEALTH ")).unwrap_or("").trim().to_string();
            Ok(RelayStatus {
                reachable: true,
                healthy: health == "healthy",
                revision: parse_revision_line(&out.stdout),
                detail: if health.is_empty() { "no health reported".into() } else { health },
            })
        }
        _ => Ok(RelayStatus { reachable: false, healthy: false, revision: None, detail: "ssh unreachable".into() }),
    }
}

pub fn run_rollback(runner: &dyn Runner, request: &RollbackRequest) -> Result<DeploymentResult, String> {
    let server = &request.server;
    validate(server, runner).map_err(String::from)?;
    let current = existing_revision(runner, server)?;
    let listing = ssh_script(runner, server, INSTALL_SCRIPT, &["releases", &server.deployment_dir, "-", &server.docker_network])?;
    let releases: Vec<String> = listing.stdout.lines().map(|l| l.trim().to_string()).collect();
    decide_rollback(current.as_deref(), &request.to_revision, &releases).map_err(String::from)?;
    let out = ssh_script(runner, server, INSTALL_SCRIPT, &["rollback", &server.deployment_dir, &request.to_revision, &server.docker_network])?;
    Ok(step_result(&out, request.to_revision.clone(), current))
}

/// Control arguments for `control.js`, validated; values are quoted later.
pub fn control_args(command: &RelayCommand) -> Result<Vec<String>, &'static str> {
    let owned = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match command {
        RelayCommand::PairingCreate => Ok(owned(&["pairing-create"])),
        RelayCommand::PairingStatus => Ok(owned(&["pairing-status"])),
        RelayCommand::TopicCreate { name, color } => {
            if name.trim().is_empty() || name.chars().count() > 128 || name.chars().any(|c| c.is_control()) {
                return Err("invalid-arguments");
            }
            Ok(vec!["topic-create".into(), "--name".into(), name.clone(), "--color".into(), color.to_string()])
        }
        RelayCommand::SendTest { application_id } | RelayCommand::SendSetupComplete { application_id } => {
            if !valid_application_id(application_id) {
                return Err("invalid-arguments");
            }
            let name = if matches!(command, RelayCommand::SendTest { .. }) { "send-test" } else { "send-setup-complete" };
            Ok(vec![name.into(), "--application".into(), application_id.clone()])
        }
        RelayCommand::AuditTail { lines } => {
            if !(1..=200).contains(lines) {
                return Err("invalid-arguments");
            }
            Ok(vec!["audit-tail".into(), "--lines".into(), lines.to_string()])
        }
    }
}

pub fn run_control(runner: &dyn Runner, request: &ServerRequest, command: &RelayCommand) -> Result<serde_json::Value, String> {
    validate(request, runner).map_err(String::from)?;
    let args = control_args(command).map_err(String::from)?;
    let quoted: Vec<String> = args.iter().map(|a| sq(a)).collect();
    let line = format!(
        "docker compose -p {PROJECT} -f {}/current/deploy/compose.yaml exec -T companion-relay node control.js {}",
        sq_dir(&request.deployment_dir),
        quoted.join(" ")
    );
    let out = runner.run(SSH, &ssh_args(request, &[&line]), b"")?;
    let value: serde_json::Value = serde_json::from_str(out.stdout.trim()).map_err(|_| "control-failed".to_string())?;
    if out.success { Ok(value) } else { Err("control-failed".into()) }
}

// `$HOME` must stay expandable on the remote side; the rest is already clean.
fn sq_dir(dir: &str) -> String {
    dir.to_string()
}

pub fn run_audit_tail(runner: &dyn Runner, request: &AuditRequest) -> Result<Vec<BTreeMap<String, serde_json::Value>>, String> {
    let value = run_control(runner, &request.server, &RelayCommand::AuditTail { lines: request.lines })?;
    serde_json::from_value(value.get("records").cloned().unwrap_or_default()).map_err(|_| "control-failed".to_string())
}

// --- Tauri commands ----------------------------------------------------------

fn bundle_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    // The array form of `bundle.resources` keeps the source layout under `_up_` segments.
    let bundled = app.path().resource_dir().map(|d| d.join("_up_/_up_/_up_/assets/relay"));
    match bundled {
        Ok(dir) if dir.is_dir() => dir,
        _ => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../assets/relay"),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| "task-failed".to_string())?
}

#[tauri::command]
pub async fn server_preflight(request: ServerRequest) -> Result<ServerPreflight, String> {
    blocking(move || run_preflight(&SystemRunner, &request)).await
}

#[tauri::command]
pub async fn deployment_preview(app: tauri::AppHandle, request: DeployRequest) -> Result<DeploymentPreview, String> {
    let dir = bundle_dir(&app);
    blocking(move || run_preview(&SystemRunner, &request, &dir)).await
}

#[tauri::command]
pub async fn deploy_relay(app: tauri::AppHandle, request: DeployRequest) -> Result<DeploymentResult, String> {
    let dir = bundle_dir(&app);
    blocking(move || {
        let store = crate::keychain::MacKeychain::new(crate::keychain::SERVICE);
        let env = crate::keychain::get_secret(&store, &request.workspace_id, ENV_KEY)
            .map_err(|e| e.code().to_string())?
            .ok_or_else(|| "relay-env-missing".to_string())?;
        run_deploy(&SystemRunner, &request, &dir, &env)
    })
    .await
}

#[tauri::command]
pub async fn relay_status(request: ServerRequest) -> Result<RelayStatus, String> {
    blocking(move || run_status(&SystemRunner, &request)).await
}

#[tauri::command]
pub async fn relay_audit_tail(request: AuditRequest) -> Result<Vec<BTreeMap<String, serde_json::Value>>, String> {
    blocking(move || run_audit_tail(&SystemRunner, &request)).await
}

#[tauri::command]
pub async fn rollback_relay(request: RollbackRequest) -> Result<DeploymentResult, String> {
    blocking(move || run_rollback(&SystemRunner, &request)).await
}

#[tauri::command]
pub async fn relay_control(request: ServerRequest, command: RelayCommand) -> Result<serde_json::Value, String> {
    blocking(move || run_control(&SystemRunner, &request, &command)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        replies: RefCell<Vec<Output>>,
        identity_ok: bool,
    }

    impl Fake {
        fn new(replies: Vec<(bool, &str)>) -> Self {
            Fake {
                calls: RefCell::new(vec![]),
                replies: RefCell::new(replies.into_iter().rev().map(|(success, s)| Output { success, stdout: s.into() }).collect()),
                identity_ok: true,
            }
        }
    }

    impl Runner for Fake {
        fn run(&self, program: &str, args: &[String], _stdin: &[u8]) -> Result<Output, String> {
            self.calls.borrow_mut().push((program.into(), args.to_vec()));
            Ok(self.replies.borrow_mut().pop().unwrap_or(Output { success: true, stdout: String::new() }))
        }
        fn is_file(&self, _path: &str) -> bool {
            self.identity_ok
        }
    }

    fn request() -> ServerRequest {
        ServerRequest {
            host: "host.example".into(),
            user: "ops".into(),
            port: 22,
            identity_file: "/Users/me/.ssh/id_ed25519".into(),
            docker_network: "glitchtip".into(),
            deployment_dir: "$HOME/.local/share/glitchtip-companion".into(),
        }
    }

    fn bundle() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("deploy")).unwrap();
        std::fs::write(dir.path().join("server.js"), "x").unwrap();
        std::fs::write(dir.path().join("server.test.js"), "t").unwrap();
        std::fs::write(dir.path().join("deploy/compose.yaml"), "services:").unwrap();
        dir
    }

    #[test]
    fn validation_rejects_bad_fields() {
        let ok = Fake::new(vec![]);
        assert_eq!(validate(&request(), &ok), Ok(()));
        let mut r = request();
        r.host = "host example".into();
        assert_eq!(validate(&r, &ok), Err("invalid-host"));
        r.host = "-oProxyCommand=x".into();
        assert_eq!(validate(&r, &ok), Err("invalid-host"));
        let mut r = request();
        r.user = "a\nb".into();
        assert_eq!(validate(&r, &ok), Err("invalid-user"));
        for port in [0, 65536] {
            let mut r = request();
            r.port = port;
            assert_eq!(validate(&r, &ok), Err("invalid-port"));
        }
        let mut r = request();
        r.docker_network = "net work".into();
        assert_eq!(validate(&r, &ok), Err("invalid-network"));
        for dir in ["/etc/passwd", "$HOME/.local/share/glitchtip-companion/../x", "$HOME/other", "relative/.local/share/glitchtip-companion", "$HOME/.local/share/glitchtip-companion; rm -rf /"] {
            let mut r = request();
            r.deployment_dir = dir.into();
            assert_eq!(validate(&r, &ok), Err("invalid-deployment-dir"), "{dir}");
        }
        let mut r = request();
        r.deployment_dir = "/home/ops/.local/share/glitchtip-companion".into();
        assert_eq!(validate(&r, &ok), Ok(()));
        let mut bad = Fake::new(vec![]);
        bad.identity_ok = false;
        assert_eq!(validate(&request(), &bad), Err("invalid-identity-file"));
        let mut default_identity = request();
        default_identity.identity_file = String::new();
        assert_eq!(validate(&default_identity, &bad), Ok(()));
        assert!(!ssh_args(&default_identity, &["true"]).iter().any(|a| a == "-i"));
    }

    #[test]
    fn ssh_args_are_pinned() {
        assert_eq!(
            ssh_args(&request(), &["bash", "-s", "--", "preflight"]),
            vec![
                "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-i",
                "/Users/me/.ssh/id_ed25519", "-p", "22", "ops@host.example", "bash", "-s", "--", "preflight",
            ]
        );
        let scp = scp_args(&request(), "/tmp/x", ".local/share/glitchtip-companion");
        assert!(scp.contains(&"StrictHostKeyChecking=yes".to_string()) && scp.contains(&"-P".to_string()));
        assert_eq!(scp_path("$HOME/.local/share/glitchtip-companion"), ".local/share/glitchtip-companion");
    }

    #[test]
    fn scripts_never_disable_host_key_checking() {
        for script in [PREFLIGHT_SCRIPT, INSTALL_SCRIPT] {
            assert!(!script.contains("StrictHostKeyChecking"));
        }
        assert!(INSTALL_SCRIPT.contains("config >/dev/null || fail config"));
        assert!(INSTALL_SCRIPT.contains("fail readiness"));
        assert!(INSTALL_SCRIPT.contains("fail synthetic-event"));
        assert!(INSTALL_SCRIPT.contains("restore()"));
        assert!(INSTALL_SCRIPT.contains("chmod 600"));
    }

    #[test]
    fn preview_lists_files_without_secrets() {
        let dir = bundle();
        let fake = Fake::new(vec![(true, "REVISION 0123456789abcdef\n")]);
        let req = DeployRequest { server: request(), workspace_id: "acme".into(), application_ids: vec!["a1".into()] };
        let preview = run_preview(&fake, &req, dir.path()).unwrap();
        assert_eq!(preview.previous_revision.as_deref(), Some("0123456789abcdef"));
        assert!(preview.files.iter().any(|f| f.path.ends_with("shared/relay.env") && f.mode == "0600"));
        assert!(preview.files.iter().all(|f| !f.path.ends_with(".test.js")));
        assert_eq!(preview.compose_services, vec!["companion-relay"]);
        assert!(preview.published_ports.is_empty());
        assert_eq!(preview.revision.len(), 16);
    }

    #[test]
    fn deploy_never_puts_env_in_argv_and_reports_failed_step() {
        let dir = bundle();
        let secret = "TELEGRAM_BOT_TOKEN=123456:SECRETVALUE";
        let fake = Fake::new(vec![(true, ""), (true, ""), (true, ""), (false, "FAILED readiness\n")]);
        let req = DeployRequest { server: request(), workspace_id: "acme".into(), application_ids: vec!["a1".into()] };
        let result = run_deploy(&fake, &req, dir.path(), secret).unwrap();
        assert!(!result.ok);
        assert_eq!(result.failed_step.as_deref(), Some("readiness"));
        let calls = fake.calls.borrow();
        assert_eq!(calls[2].0, SCP);
        assert!(calls.iter().all(|(p, a)| (p == SSH || p == SCP) && a.iter().all(|x| !x.contains("SECRETVALUE"))));
        assert!(!format!("{result:?}").contains("SECRETVALUE"));
    }

    #[test]
    fn deploy_success_needs_ok_marker() {
        let dir = bundle();
        let rev = revision_of(&collect_bundle(dir.path()).unwrap());
        let fake = Fake::new(vec![(true, ""), (true, ""), (true, ""), (true, &format!("OK {rev}\n"))]);
        let req = DeployRequest { server: request(), workspace_id: "acme".into(), application_ids: vec!["a1".into()] };
        let result = run_deploy(&fake, &req, dir.path(), "A=b").unwrap();
        assert!(result.ok && result.failed_step.is_none() && result.revision == rev);
    }

    #[test]
    fn deploy_accepts_an_unpaired_relay_with_no_applications() {
        let dir = bundle();
        let rev = revision_of(&collect_bundle(dir.path()).unwrap());
        let fake = Fake::new(vec![(true, ""), (true, ""), (true, ""), (true, &format!("OK {rev}\n"))]);
        let req = DeployRequest { server: request(), workspace_id: "acme".into(), application_ids: vec![] };
        assert!(run_deploy(&fake, &req, dir.path(), "A=b").unwrap().ok);
        let bad = DeployRequest { server: request(), workspace_id: "acme".into(), application_ids: vec!["-x".into()] };
        assert_eq!(run_deploy(&Fake::new(vec![]), &bad, dir.path(), "A=b").err().as_deref(), Some("invalid-application-id"));
    }

    /// Runs INSTALL_SCRIPT with bash against a temporary deployment directory,
    /// with `docker` and `sleep` stubbed: `ps` reports `health`, `build`
    /// runs `on_build` as shell, and each call is logged after the release it
    /// runs as. `extra` adds stubs, which run as children of the installer.
    fn install(
        current: Option<&str>,
        previous: Option<&str>,
        rev: &str,
        health: &str,
        on_build: &str,
        extra: &[(&str, &str)],
    ) -> (tempfile::TempDir, String) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("dir");
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let stub = |name: &str, body: &str| {
            let path = bin.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        stub("docker", &format!("echo \"$COMPANION_RELEASE $*\" >> \"{}\"\ncase \"$*\" in *\" ps \"*) echo {health};; *\" build\") {on_build};; esac\nexit 0", root.path().join("docker.log").display()));
        stub("sleep", "exit 0");
        for (name, body) in extra {
            stub(name, body);
        }
        if let Some(current) = current {
            std::fs::create_dir_all(dir.join("releases").join(current).join("deploy")).unwrap();
            std::fs::write(dir.join("releases").join(current).join("deploy/compose.yaml"), "services:").unwrap();
            std::fs::create_dir_all(dir.join("shared")).unwrap();
            std::fs::write(dir.join("shared/relay.env"), "OLD").unwrap();
            std::os::unix::fs::symlink(dir.join("releases").join(current), dir.join("current")).unwrap();
        }
        if let Some(previous) = previous {
            std::fs::create_dir_all(dir.join("releases").join(previous).join("deploy")).unwrap();
            std::os::unix::fs::symlink(dir.join("releases").join(previous), dir.join("previous")).unwrap();
        }
        let incoming = dir.join(format!("incoming-{rev}"));
        std::fs::create_dir_all(incoming.join("bundle/deploy")).unwrap();
        std::fs::write(incoming.join("bundle/deploy/compose.yaml"), "services:").unwrap();
        std::fs::write(incoming.join("relay.env"), "NEW").unwrap();
        let mut child = Command::new("bash")
            .args(["-s", "--", "install", &dir.to_string_lossy(), rev, "glitchtip"])
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(INSTALL_SCRIPT.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        (root, String::from_utf8_lossy(&out.stdout).into_owned())
    }

    #[test]
    fn a_failed_redeploy_of_the_same_release_restores_its_environment() {
        let rev = "aaaaaaaaaaaaaaaa";
        let (root, stdout) = install(Some(rev), None, rev, "starting", ":", &[]);
        let dir = root.path().join("dir");
        assert!(stdout.contains("FAILED readiness"), "{stdout}");
        assert_eq!(std::fs::read_to_string(dir.join("shared/relay.env")).unwrap(), "OLD");
        assert!(!dir.join("shared/relay.env.prev").exists());
        assert!(dir.join(format!("releases/{rev}/deploy/compose.yaml")).exists());
        // A release is never its own rollback target.
        assert!(std::fs::symlink_metadata(dir.join("previous")).is_err());
        let log = std::fs::read_to_string(root.path().join("docker.log")).unwrap();
        assert!(log.lines().last().unwrap().ends_with("up -d"), "{log}");
    }

    #[test]
    fn a_new_release_keeps_its_environment_and_the_one_before_as_previous() {
        let (root, stdout) = install(Some("aaaaaaaaaaaaaaaa"), None, "bbbbbbbbbbbbbbbb", "healthy", ":", &[]);
        let dir = root.path().join("dir");
        assert!(stdout.contains("OK bbbbbbbbbbbbbbbb"), "{stdout}");
        assert_eq!(std::fs::read_to_string(dir.join("shared/relay.env")).unwrap(), "NEW");
        assert!(!dir.join("shared/relay.env.prev").exists());
        assert_eq!(std::fs::read_link(dir.join("previous")).unwrap(), dir.join("releases/aaaaaaaaaaaaaaaa"));
        assert_eq!(std::fs::read_link(dir.join("current")).unwrap(), dir.join("releases/bbbbbbbbbbbbbbbb"));
    }

    #[test]
    fn a_first_install_has_no_environment_to_restore() {
        let (root, stdout) = install(None, None, "bbbbbbbbbbbbbbbb", "healthy", ":", &[]);
        assert!(stdout.contains("OK bbbbbbbbbbbbbbbb"), "{stdout}");
        assert_eq!(std::fs::read_to_string(root.path().join("dir/shared/relay.env")).unwrap(), "NEW");
    }

    #[test]
    fn a_signal_while_the_release_is_switched_does_not_undo_it() {
        let ln = "case \"$*\" in */current) kill -TERM $PPID;; esac\nexec /bin/ln \"$@\"";
        let (root, stdout) = install(Some("bbbbbbbbbbbbbbbb"), Some("aaaaaaaaaaaaaaaa"), "cccccccccccccccc", "healthy", ":", &[("ln", ln)]);
        let dir = root.path().join("dir");
        assert!(stdout.contains("OK cccccccccccccccc"), "{stdout}");
        assert_eq!(std::fs::read_to_string(dir.join("shared/relay.env")).unwrap(), "NEW");
        assert_eq!(std::fs::read_link(dir.join("current")).unwrap(), dir.join("releases/cccccccccccccccc"));
        assert_eq!(std::fs::read_link(dir.join("previous")).unwrap(), dir.join("releases/bbbbbbbbbbbbbbbb"));
    }

    #[test]
    fn a_failed_first_install_stops_the_relay_it_started() {
        let (root, stdout) = install(None, None, "bbbbbbbbbbbbbbbb", "starting", ":", &[]);
        assert!(stdout.contains("FAILED readiness"), "{stdout}");
        // Nothing ran before it, so its secrets do not stay behind either.
        assert!(!root.path().join("dir/shared/relay.env").exists());
        let log = std::fs::read_to_string(root.path().join("docker.log")).unwrap();
        assert!(log.lines().last().unwrap().ends_with(" down"), "{log}");
        assert!(!log.contains("-v"), "the state volume is kept: {log}");
    }

    #[test]
    fn a_failed_new_release_keeps_the_rollback_target() {
        let (root, stdout) = install(Some("bbbbbbbbbbbbbbbb"), Some("aaaaaaaaaaaaaaaa"), "cccccccccccccccc", "starting", ":", &[]);
        let dir = root.path().join("dir");
        assert!(stdout.contains("FAILED readiness"), "{stdout}");
        // The restored container runs the running release's own image, not the one just built.
        let log = std::fs::read_to_string(root.path().join("docker.log")).unwrap();
        let last = log.lines().last().unwrap();
        assert!(last.starts_with("bbbbbbbbbbbbbbbb ") && last.ends_with("up -d"), "{log}");
        assert!(log.lines().any(|l| l.starts_with("cccccccccccccccc ") && l.ends_with(" build")), "{log}");
        assert_eq!(std::fs::read_link(dir.join("current")).unwrap(), dir.join("releases/bbbbbbbbbbbbbbbb"));
        assert_eq!(std::fs::read_link(dir.join("previous")).unwrap(), dir.join("releases/aaaaaaaaaaaaaaaa"));
    }

    #[test]
    fn an_interrupted_install_restores_the_environment() {
        let (root, stdout) = install(Some("aaaaaaaaaaaaaaaa"), None, "bbbbbbbbbbbbbbbb", "healthy", "kill -TERM $PPID", &[]);
        let dir = root.path().join("dir");
        assert!(stdout.contains("FAILED interrupted"), "{stdout}");
        assert_eq!(std::fs::read_to_string(dir.join("shared/relay.env")).unwrap(), "OLD");
        assert_eq!(std::fs::read_link(dir.join("current")).unwrap(), dir.join("releases/aaaaaaaaaaaaaaaa"));
    }

    #[test]
    fn rollback_decisions() {
        let releases = vec!["aaaaaaaaaaaaaaaa".to_string(), "bbbbbbbbbbbbbbbb".to_string()];
        assert_eq!(decide_rollback(Some("bbbbbbbbbbbbbbbb"), "aaaaaaaaaaaaaaaa", &releases), Ok(()));
        assert_eq!(decide_rollback(Some("aaaaaaaaaaaaaaaa"), "aaaaaaaaaaaaaaaa", &releases), Err("already-current"));
        assert_eq!(decide_rollback(None, "cccccccccccccccc", &releases), Err("unknown-revision"));
        assert_eq!(decide_rollback(None, "../etc", &releases), Err("invalid-revision"));
    }

    #[test]
    fn rollback_refuses_unknown_without_switching() {
        let fake = Fake::new(vec![(true, "REVISION bbbbbbbbbbbbbbbb\n"), (true, "bbbbbbbbbbbbbbbb\n")]);
        let req = RollbackRequest { server: request(), to_revision: "aaaaaaaaaaaaaaaa".into() };
        assert_eq!(run_rollback(&fake, &req), Err("unknown-revision".to_string()));
        assert_eq!(fake.calls.borrow().len(), 2);
    }

    #[test]
    fn control_commands_are_validated_and_quoted() {
        assert_eq!(control_args(&RelayCommand::AuditTail { lines: 0 }), Err("invalid-arguments"));
        assert_eq!(control_args(&RelayCommand::AuditTail { lines: 201 }), Err("invalid-arguments"));
        assert_eq!(control_args(&RelayCommand::SendTest { application_id: "a b".into() }), Err("invalid-arguments"));
        let fake = Fake::new(vec![(true, "{\"topicId\":3}\n")]);
        let cmd = RelayCommand::TopicCreate { name: "it's; rm -rf /".into(), color: 7322096 };
        let value = run_control(&fake, &request(), &cmd).unwrap();
        assert_eq!(value["topicId"], 3);
        let calls = fake.calls.borrow();
        let remote = calls[0].1.last().unwrap();
        assert!(remote.contains("exec -T companion-relay node control.js 'topic-create' '--name' 'it'\\''s; rm -rf /'"));
    }

    #[test]
    fn command_serde_shapes() {
        let c: RelayCommand = serde_json::from_str(r#"{"kind":"send-test","applicationId":"a1"}"#).unwrap();
        assert!(matches!(c, RelayCommand::SendTest { .. }));
        let r: DeployRequest = serde_json::from_str(r#"{"host":"h","user":"u","port":22,"identityFile":"/k","dockerNetwork":"n","deploymentDir":"d","workspaceId":"w","applicationIds":["a"]}"#).unwrap();
        assert_eq!(r.server.identity_file, "/k");
    }

    #[test]
    fn preflight_accepts_compose_2_and_later() {
        let bin = tempfile::tempdir().unwrap();
        let docker = bin.path().join("docker");
        std::fs::write(&docker, "#!/bin/sh\n[ \"$*\" = 'compose version --short' ] && echo \"$COMPOSE\"\nexit 0\n").unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let compose = |version: &str| {
            let out = std::process::Command::new("bash")
                .args(["-c", PREFLIGHT_SCRIPT, "bash", "preflight", bin.path().join("dir").to_str().unwrap(), "net"])
                .env("PATH", format!("{}:/usr/bin:/bin", bin.path().display()))
                .env("COMPOSE", version)
                .output()
                .unwrap();
            let stdout = String::from_utf8(out.stdout).unwrap();
            stdout.lines().find(|l| l.starts_with("CHECK compose ")).unwrap().split(' ').nth(2).unwrap().to_string()
        };
        for (version, expected) in [("2.29.1", "ok"), ("v2.20.0", "ok"), ("5.6.1", "ok"), ("1.29.2", "fail"), ("dev", "fail")] {
            assert_eq!(compose(version), expected, "Compose {version}");
        }
    }

    #[test]
    fn preflight_requires_glitchtip_on_the_network_with_private_webhooks_allowed() {
        let bin = tempfile::tempdir().unwrap();
        let docker = bin.path().join("docker");
        // Containers and their images and environments come from the test's variables.
        std::fs::write(
            &docker,
            "#!/bin/sh\ncase \"$1 $2\" in\n\
             'network inspect') echo \"$CONTAINERS\";;\n\
             'inspect -f') case \"$3\" in *Image*) eval \"echo \\$IMAGE_$4\";; *Env*) eval \"printf '%b' \\\"\\$ENV_$4\\\"\";; esac;;\n\
             esac\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&docker, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = |containers: &str, env: &[(&str, &str)]| {
            let mut command = std::process::Command::new("bash");
            command
                .args(["-c", PREFLIGHT_SCRIPT, "bash", "preflight", bin.path().join("dir").to_str().unwrap(), "net"])
                .env("PATH", format!("{}:/usr/bin:/bin", bin.path().display()))
                .env("CONTAINERS", containers)
                .env("IMAGE_web", "glitchtip/glitchtip:v6.2.6")
                .env("IMAGE_worker", "glitchtip/glitchtip:v6.2.6")
                .env("IMAGE_relay", "glitchtip-companion-relay:abc")
                .env("IMAGE_errors", "registry.acme.internal/errors:6.2")
                .env("IMAGE_db", "postgres:17");
            for (key, value) in env {
                command.env(key, value);
            }
            let stdout = String::from_utf8(command.output().unwrap().stdout).unwrap();
            assert!(!stdout.contains("never-printed"), "GlitchTip's other variables stay on the server");
            let status = |id: &str| {
                stdout.lines().find(|l| l.starts_with(&format!("CHECK {id} "))).map(|l| l.split(' ').nth(2).unwrap().to_string())
            };
            (status("glitchtip-network"), status("glitchtip-webhooks"))
        };
        let on = "PATH=/usr/bin\\nGLITCHTIP_ALLOW_PRIVATE_IPS=True\\n";
        let off = "PATH=/usr/bin\\nSECRET_KEY=never-printed\\n";
        let ok = || Some("ok".to_string());
        let fail = || Some("fail".to_string());
        assert_eq!(run("web worker db relay", &[("ENV_web", on), ("ENV_worker", on)]), (ok(), ok()));
        assert_eq!(run("web worker db", &[("ENV_web", on), ("ENV_worker", off)]), (ok(), fail()));
        assert_eq!(run("db relay", &[]), (fail(), None));
        // A renamed image counts by GlitchTip's own setting; another container with neither does not.
        let renamed = "GLITCHTIP_DOMAIN=https://gt.acme.example\\nGLITCHTIP_ALLOW_PRIVATE_IPS=1\\n";
        assert_eq!(run("errors db", &[("ENV_errors", renamed), ("ENV_db", off)]), (ok(), ok()));
        assert_eq!(run("errors", &[("ENV_errors", off)]), (fail(), None));
        assert_eq!(run("", &[]), (fail(), None));
    }

    #[test]
    fn preflight_parses_checks() {
        let fake = Fake::new(vec![(true, "CHECK linux ok Linux 6.1\nCHECK docker fail docker missing\nREVISION 0123456789abcdef\n")]);
        let result = run_preflight(&fake, &request()).unwrap();
        assert!(!result.ok);
        assert_eq!(result.checks.len(), 2);
        assert_eq!(result.existing_revision.as_deref(), Some("0123456789abcdef"));
    }

    /// Real SSH and real Docker, against the stand-in server test/companion-ssh-e2e/run.sh starts.
    /// ssh never reads ~/.ssh here: run.sh passes the only key and known host.
    #[derive(Clone)]
    struct Isolated(String);

    impl Runner for Isolated {
        fn run(&self, program: &str, args: &[String], stdin: &[u8]) -> Result<Output, String> {
            let mut all: Vec<String> = ["-F", "/dev/null", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            all.extend(["-o".to_string(), format!("UserKnownHostsFile={}", self.0)]);
            all.extend_from_slice(args);
            SystemRunner.run(program, &all, stdin)
        }
        fn is_file(&self, path: &str) -> bool {
            SystemRunner.is_file(path)
        }
    }

    #[test]
    #[ignore = "needs the stand-in server from test/companion-ssh-e2e/run.sh"]
    fn ssh_e2e_deploys_the_relay_over_real_ssh() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is set by run.sh"));
        let runner = Isolated(var("COMPANION_SSH_E2E_KNOWN_HOSTS"));
        let server = ServerRequest {
            host: "127.0.0.1".into(),
            user: "root".into(),
            port: var("COMPANION_SSH_E2E_PORT").parse().unwrap(),
            identity_file: var("COMPANION_SSH_E2E_KEY"),
            docker_network: var("COMPANION_SSH_E2E_NETWORK"),
            deployment_dir: "$HOME/.local/share/glitchtip-companion".into(),
        };
        fn shell(runner: &Isolated, server: &ServerRequest, line: &str) -> String {
            runner.run(SSH, &ssh_args(server, &[line]), b"").unwrap().stdout
        }

        let preflight = run_preflight(&runner, &server).unwrap();
        let failed: Vec<_> = preflight.checks.iter().filter(|c| !c.ok).map(|c| (&c.id, &c.detail)).collect();
        assert!(preflight.ok, "pre-flight failed: {failed:?}");

        // What src/lib/relay-config.ts writes for an unpaired relay. The bot token is made up, so
        // Telegram's getMe refuses it and the relay never reports ready.
        let env = "COMPANION_WORKSPACE_ID='e2e'\nCOMPANION_LOCALE='en'\nTELEGRAM_BOT_TOKEN='123456:not-a-real-token'\n\
                   GLITCHTIP_API_BASE='https://glitchtip.example.com'\nGLITCHTIP_API_TOKEN='e2e-token'\n";
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../assets/relay");
        let request = DeployRequest { server: server.clone(), workspace_id: "e2e".into(), application_ids: vec![] };

        // While the installer waits for readiness, the relay must have accepted its configuration,
        // from a 0600 relay.env, with exactly the values above in its environment.
        let watcher = {
            let runner = runner.clone();
            let server = server.clone();
            std::thread::spawn(move || {
                let probe = "c=glitchtip-companion-companion-relay-1; \
                             docker logs $c 2>&1 | grep -q 'relay: not paired; waiting for a pairing code' || exit 0; \
                             stat -c 'mode=%a' \"$HOME/.local/share/glitchtip-companion/shared/relay.env\"; \
                             docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $c";
                for _ in 0..120 {
                    let seen = shell(&runner, &server, probe);
                    if !seen.trim().is_empty() {
                        return seen;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
                String::new()
            })
        };
        let result = run_deploy(&runner, &request, &bundle, env).unwrap();
        let seen = watcher.join().unwrap();
        let seen: Vec<&str> = seen.lines().collect();
        assert!(seen.contains(&"mode=600"), "the relay never started from a 0600 relay.env: {seen:?}");
        for line in env.lines() {
            let (key, value) = line.split_once('=').unwrap();
            let expected = format!("{key}={}", value.trim_matches('\''));
            assert!(seen.contains(&expected.as_str()), "the relay was not given {key}: {seen:?}");
        }
        assert_eq!(result.failed_step.as_deref(), Some("readiness"), "{result:?}");

        // A failed first install leaves no relay running and no secrets behind; its image keeps
        // the release tag a later rollback would start.
        let after = shell(
            &runner,
            &server,
            &format!(
                "test ! -e \"$HOME/.local/share/glitchtip-companion/shared/relay.env\" && echo no-env; \
                 docker ps -q --filter label=com.docker.compose.project={PROJECT} | grep -q . || echo stopped; \
                 docker image inspect glitchtip-companion-relay:{} >/dev/null 2>&1 && echo tagged",
                result.revision
            ),
        );
        assert_eq!(after.split_whitespace().collect::<Vec<_>>(), ["no-env", "stopped", "tagged"], "{after}");
    }
}
