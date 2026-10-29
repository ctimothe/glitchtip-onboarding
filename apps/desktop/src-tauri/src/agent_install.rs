// Preview, install and verify the project-local agent skill and context helper.
//
// The canonical skill lives in the bundled `assets/agent-skill` directory. An
// install writes `.glitchtip-companion.json` and the canonical skill into the
// repository's `.agents/skills/glitchtip-investigate`, and, per selected
// provider, a RELATIVE symlink from `.codex/skills` or `.claude/skills` to it,
// so moving the repository never breaks an adapter.
//
// Every file is first written into a staging directory inside the repository
// (same filesystem, so the final rename is atomic), every path is validated
// against the repository boundary, and only then renamed into place.
//
// Like `keychain.rs`, every command fails with a stable code string from
// `AgentError::code` and nothing else: file contents, paths and helper output
// never go into an error.
//
// The helper runs behind `HelperRunner` so verification is unit-tested with a
// fake; `ProcessRunner` is the only implementation that spawns a process.

use std::fs;
use std::io::Read;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

pub const CONFIG_FILE: &str = ".glitchtip-companion.json";
pub const SKILL_NAME: &str = "glitchtip-investigate";
const GENERATED_FILE_VERSION: u32 = 1;
const SKILL_FILES: [&str; 2] = ["SKILL.md", "references/evidence-policy.md"];
const CANONICAL_DIR: &str = ".agents/skills/glitchtip-investigate";
const HELPER_NAME: &str = "glitchtip-companion";
const HELPER_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentError {
    InvalidRequest,
    InvalidRepository,
    NotAGitRepository,
    SymlinkEscape,
    ForeignSkillDirectory,
    SecretInPreview,
    SkillSourceMissing,
    WriteFailed,
    HelperNotInstalled,
    AppTranslocated,
}

impl AgentError {
    /// The only text that crosses IPC for a failure.
    pub fn code(self) -> &'static str {
        match self {
            AgentError::InvalidRequest => "invalid-agent-request",
            AgentError::InvalidRepository => "invalid-repository",
            AgentError::NotAGitRepository => "not-a-git-repository",
            AgentError::SymlinkEscape => "symlink-escape",
            AgentError::ForeignSkillDirectory => "foreign-skill-directory",
            AgentError::SecretInPreview => "secret-in-preview",
            AgentError::SkillSourceMissing => "skill-source-missing",
            AgentError::WriteFailed => "agent-write-failed",
            AgentError::HelperNotInstalled => "helper-not-installed",
            AgentError::AppTranslocated => "app-translocated",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Codex,
    Claude,
    Other,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallRequest {
    pub workspace_id: String,
    pub application_id: String,
    pub repository_path: String,
    pub providers: Vec<AgentProvider>,
    /// Not in the agreed shape; optional so the TS side stays valid. Written
    /// into `.glitchtip-companion.json` (empty when the caller omits them).
    #[serde(default)]
    pub project_slug: String,
    #[serde(default)]
    pub glitchtip_base_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileAction {
    Create,
    Unchanged,
    Update,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub path: String,
    pub action: FileAction,
    pub diff: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallPreview {
    pub files: Vec<PreviewFile>,
    pub helper_path: String,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallResult {
    pub installed: Vec<String>,
    pub unchanged: Vec<String>,
    pub helper_installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVerifyResult {
    pub ok: bool,
    pub failed_step: Option<String>,
    pub canary_found: bool,
    pub incident_ref: String,
}

/// One planned entry: either a regular file with content, or a relative symlink.
#[derive(Debug, Clone)]
enum Planned {
    File { rel: String, content: String },
    Link { rel: String, target: String },
}

impl Planned {
    fn rel(&self) -> &str {
        match self {
            Planned::File { rel, .. } | Planned::Link { rel, .. } => rel,
        }
    }
}

struct Plan {
    repo: PathBuf,
    entries: Vec<(Planned, PreviewFile)>,
}

// ---------------------------------------------------------------- validation

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn valid_optional_slug(value: &str) -> bool {
    value.is_empty() || valid_identifier(value)
}

fn valid_optional_base_url(value: &str) -> bool {
    value.is_empty()
        || ((value.starts_with("https://") || value.starts_with("http://localhost"))
            && value.len() <= 256
            && !value.bytes().any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
            && !value.contains('@'))
}

fn validate_request(request: &AgentInstallRequest) -> Result<(), AgentError> {
    if !valid_identifier(&request.workspace_id)
        || !valid_identifier(&request.application_id)
        || !valid_optional_slug(&request.project_slug)
        || !valid_optional_base_url(&request.glitchtip_base_url)
        || request.repository_path.is_empty()
    {
        return Err(AgentError::InvalidRequest);
    }
    Ok(())
}

/// Detects values that must never appear in generated files or helper output.
pub fn contains_secret(text: &str) -> bool {
    const MARKERS: [&str; 6] = [
        "sntrys_",
        "sntryu_",
        "COMPANION_CANARY",
        "GLITCHTIP_CANARY",
        "-----BEGIN ",
        "Bearer ",
    ];
    if MARKERS.iter().any(|m| text.contains(m)) {
        return true;
    }
    // A DSN: `scheme://<key>@host`, with no path or space before the `@`.
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let after = &rest[i + 3..];
        let token: String = after
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '/' && *c != '"')
            .collect();
        if token.contains('@') {
            return true;
        }
        rest = after;
    }
    false
}

fn canonical_repository(path: &str) -> Result<PathBuf, AgentError> {
    let repo = fs::canonicalize(path).map_err(|_| AgentError::InvalidRepository)?;
    if !repo.is_dir() {
        return Err(AgentError::InvalidRepository);
    }
    if !repo.join(".git").exists() {
        return Err(AgentError::NotAGitRepository);
    }
    Ok(repo)
}

/// Every existing ancestor directory of a generated path must stay inside the
/// repository once symlinks are resolved.
fn check_ancestors(repo: &Path, rel: &str) -> Result<(), AgentError> {
    let mut current = repo.to_path_buf();
    let parts: Vec<&str> = rel.split('/').collect();
    for part in &parts[..parts.len() - 1] {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    let resolved =
                        fs::canonicalize(&current).map_err(|_| AgentError::SymlinkEscape)?;
                    if !resolved.starts_with(repo) {
                        return Err(AgentError::SymlinkEscape);
                    }
                }
            }
            Err(_) => break,
        }
    }
    Ok(())
}

fn is_companion_skill(dir: &Path) -> bool {
    fs::read_to_string(dir.join("SKILL.md"))
        .map(|text| {
            text.lines()
                .take(8)
                .any(|l| l.trim() == format!("name: {SKILL_NAME}"))
        })
        .unwrap_or(false)
}

// ---------------------------------------------------------------------- diff

/// Line diff by longest common subsequence: `-old` / `+new`, context omitted.
pub fn line_diff(old: &str, new: &str) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            i += 1;
            j += 1;
        } else if j < b.len() && (i == a.len() || lcs[i][j + 1] > lcs[i + 1][j]) {
            out.push(format!("+{}", b[j]));
            j += 1;
        } else {
            out.push(format!("-{}", a[i]));
            i += 1;
        }
    }
    out.join("\n")
}

// ---------------------------------------------------------------------- plan

fn config_content(request: &AgentInstallRequest) -> String {
    let value = serde_json::json!({
        "schemaVersion": 1,
        "workspaceId": request.workspace_id,
        "applicationId": request.application_id,
        "projectSlug": request.project_slug,
        "glitchtipBaseUrl": request.glitchtip_base_url,
        "generatedFileVersion": GENERATED_FILE_VERSION,
    });
    let mut text = serde_json::to_string_pretty(&value).unwrap_or_default();
    text.push('\n');
    text
}

fn provider_dirs(providers: &[AgentProvider]) -> Vec<&'static str> {
    let mut dirs = Vec::new();
    for p in providers {
        let dir = match p {
            AgentProvider::Codex => ".codex/skills",
            AgentProvider::Claude => ".claude/skills",
            AgentProvider::Other => continue,
        };
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn build_plan(request: &AgentInstallRequest, skill_src: &Path) -> Result<Plan, AgentError> {
    validate_request(request)?;
    let repo = canonical_repository(&request.repository_path)?;

    let mut planned = vec![Planned::File {
        rel: CONFIG_FILE.to_string(),
        content: config_content(request),
    }];
    for name in SKILL_FILES {
        let content = fs::read_to_string(skill_src.join(name))
            .map_err(|_| AgentError::SkillSourceMissing)?;
        planned.push(Planned::File {
            rel: format!("{CANONICAL_DIR}/{name}"),
            content,
        });
    }
    for dir in provider_dirs(&request.providers) {
        planned.push(Planned::Link {
            rel: format!("{dir}/{SKILL_NAME}"),
            target: format!("../../{CANONICAL_DIR}"),
        });
    }

    // Canonical skill directory must be absent or already Companion's.
    let canonical = repo.join(CANONICAL_DIR);
    if fs::symlink_metadata(&canonical).is_ok() && !is_companion_skill(&canonical) {
        return Err(AgentError::ForeignSkillDirectory);
    }

    let mut entries = Vec::new();
    for item in planned {
        check_ancestors(&repo, item.rel())?;
        let abs = repo.join(item.rel());
        let preview = match &item {
            Planned::File { rel, content } => {
                if contains_secret(content) {
                    return Err(AgentError::SecretInPreview);
                }
                match fs::symlink_metadata(&abs) {
                    Err(_) => PreviewFile {
                        path: rel.clone(),
                        action: FileAction::Create,
                        diff: None,
                    },
                    Ok(meta) if meta.file_type().is_symlink() => {
                        // A file replaced by a symlink could redirect the write.
                        return Err(AgentError::SymlinkEscape);
                    }
                    Ok(_) => {
                        let existing =
                            fs::read_to_string(&abs).map_err(|_| AgentError::WriteFailed)?;
                        if existing == *content {
                            PreviewFile {
                                path: rel.clone(),
                                action: FileAction::Unchanged,
                                diff: None,
                            }
                        } else {
                            PreviewFile {
                                path: rel.clone(),
                                action: FileAction::Update,
                                diff: Some(line_diff(&existing, content)),
                            }
                        }
                    }
                }
            }
            Planned::Link { rel, target } => match fs::symlink_metadata(&abs) {
                Err(_) => PreviewFile {
                    path: rel.clone(),
                    action: FileAction::Create,
                    diff: None,
                },
                Ok(meta) if meta.file_type().is_symlink() => {
                    match fs::read_link(&abs) {
                        Ok(current) if current == Path::new(target) => PreviewFile {
                            path: rel.clone(),
                            action: FileAction::Unchanged,
                            diff: None,
                        },
                        _ => return Err(AgentError::ForeignSkillDirectory),
                    }
                }
                Ok(_) => return Err(AgentError::ForeignSkillDirectory),
            },
        };
        entries.push((item, preview));
    }
    Ok(Plan { repo, entries })
}

pub fn helper_target(home: &Path) -> PathBuf {
    home.join("Library/Application Support/dev.ctimothe.glitchtip-onboarding/bin")
        .join(HELPER_NAME)
}

pub fn preview_install(
    request: &AgentInstallRequest,
    skill_src: &Path,
    home: &Path,
) -> Result<AgentInstallPreview, AgentError> {
    let plan = build_plan(request, skill_src)?;
    let files: Vec<PreviewFile> = plan.entries.into_iter().map(|(_, p)| p).collect();
    let requires_confirmation = files.iter().any(|f| f.action == FileAction::Update);
    Ok(AgentInstallPreview {
        files,
        helper_path: helper_target(home).to_string_lossy().into_owned(),
        requires_confirmation,
    })
}

// ------------------------------------------------------------------- install

struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

/// The script at the helper path. It starts the app's own executable as the helper
/// (`helper::LAUNCH_FLAG`), so there is one program to sign, and the Keychain item the app
/// created is read by the app that created it.
pub fn launcher_script(app_executable: &Path) -> String {
    let quoted = app_executable.to_string_lossy().replace('\'', "'\\''");
    format!(
        "#!/bin/sh\n# GlitchTip Companion context helper, written by the app: the app itself answers.\nexec '{quoted}' {} \"$@\"\n",
        crate::helper::LAUNCH_FLAG
    )
}

/// Writes the launcher for `app_executable` at `target` through a sibling temp file, mode 0755.
fn install_launcher(app_executable: &Path, target: &Path) -> Result<(), AgentError> {
    // A quarantined app runs from a random read-only copy that is gone once it quits: a launcher
    // pointing there would stop working, so the app must be moved first.
    if app_executable.to_string_lossy().contains("/AppTranslocation/") {
        return Err(AgentError::AppTranslocated);
    }
    let parent = target.parent().ok_or(AgentError::WriteFailed)?;
    fs::create_dir_all(parent).map_err(|_| AgentError::WriteFailed)?;
    let tmp = parent.join(format!(".{HELPER_NAME}.{}.tmp", unique_suffix()));
    let result = fs::write(&tmp, launcher_script(app_executable))
        .and_then(|_| fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)))
        .and_then(|_| fs::rename(&tmp, target));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(AgentError::WriteFailed);
    }
    Ok(())
}

pub fn install(
    request: &AgentInstallRequest,
    skill_src: &Path,
    home: &Path,
    app_executable: Option<&Path>,
) -> Result<AgentInstallResult, AgentError> {
    let plan = build_plan(request, skill_src)?;
    let repo = plan.repo.clone();

    let staging = Staging(repo.join(format!(".glitchtip-companion-staging-{}", unique_suffix())));
    fs::create_dir(&staging.0).map_err(|_| AgentError::WriteFailed)?;

    let mut installed = Vec::new();
    let mut unchanged = Vec::new();
    let mut to_move: Vec<(PathBuf, PathBuf)> = Vec::new();

    for (item, preview) in &plan.entries {
        if preview.action == FileAction::Unchanged {
            unchanged.push(preview.path.clone());
            continue;
        }
        let staged = staging.0.join(item.rel());
        fs::create_dir_all(staged.parent().ok_or(AgentError::WriteFailed)?)
            .map_err(|_| AgentError::WriteFailed)?;
        match item {
            Planned::File { content, .. } => {
                fs::write(&staged, content).map_err(|_| AgentError::WriteFailed)?
            }
            Planned::Link { target, .. } => {
                symlink(target, &staged).map_err(|_| AgentError::WriteFailed)?
            }
        }
        // Validate before anything is renamed into the live tree.
        let parent = fs::canonicalize(staged.parent().ok_or(AgentError::WriteFailed)?)
            .map_err(|_| AgentError::WriteFailed)?;
        if !parent.starts_with(&repo) || item.rel().split('/').any(|c| c == ".." || c.is_empty()) {
            return Err(AgentError::SymlinkEscape);
        }
        if Path::new(item.rel())
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(AgentError::InvalidRequest);
        }
        to_move.push((staged, repo.join(item.rel())));
        installed.push(preview.path.clone());
    }

    for (staged, dest) in to_move {
        fs::create_dir_all(dest.parent().ok_or(AgentError::WriteFailed)?)
            .map_err(|_| AgentError::WriteFailed)?;
        // Re-check at the last moment: the parent may have changed meanwhile.
        let parent = fs::canonicalize(dest.parent().ok_or(AgentError::WriteFailed)?)
            .map_err(|_| AgentError::WriteFailed)?;
        if !parent.starts_with(&repo) {
            return Err(AgentError::SymlinkEscape);
        }
        fs::rename(&staged, &dest).map_err(|_| AgentError::WriteFailed)?;
    }

    let target = helper_target(home);
    let helper_installed = match app_executable {
        Some(exe) => {
            install_launcher(exe, &target)?;
            true
        }
        None => target.is_file(),
    };

    Ok(AgentInstallResult {
        installed,
        unchanged,
        helper_installed,
    })
}

// -------------------------------------------------------------------- verify

pub struct HelperOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub trait HelperRunner {
    fn run(&self, helper: &Path, args: &[String], cwd: &Path) -> Result<HelperOutput, AgentError>;
}

pub struct ProcessRunner;

impl HelperRunner for ProcessRunner {
    fn run(&self, helper: &Path, args: &[String], cwd: &Path) -> Result<HelperOutput, AgentError> {
        let mut child = Command::new(helper)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| AgentError::HelperNotInstalled)?;
        let started = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started.elapsed() < HELPER_TIMEOUT => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(HelperOutput {
                        success: false,
                        stdout: String::new(),
                        stderr: String::new(),
                    });
                }
            }
        };
        let mut stdout = String::new();
        let mut stderr = String::new();
        if let Some(mut s) = child.stdout.take() {
            let _ = s.read_to_string(&mut stdout);
        }
        if let Some(mut s) = child.stderr.take() {
            let _ = s.read_to_string(&mut stderr);
        }
        Ok(HelperOutput {
            success: status.success(),
            stdout,
            stderr,
        })
    }
}

fn fail(step: &str, canary_found: bool, incident_ref: String) -> AgentVerifyResult {
    AgentVerifyResult {
        ok: false,
        failed_step: Some(step.to_string()),
        canary_found,
        incident_ref,
    }
}

pub fn verify(
    request: &AgentInstallRequest,
    home: &Path,
    runner: &dyn HelperRunner,
) -> Result<AgentVerifyResult, AgentError> {
    validate_request(request)?;
    let repo = canonical_repository(&request.repository_path)?;
    let helper = helper_target(home);
    if !helper.is_file() {
        return Err(AgentError::HelperNotInstalled);
    }
    // A test reference: the helper resolves it and proves GlitchTip accepts the token, with no
    // issue to read.
    let incident_ref = format!("gt:{}:test", request.application_id);

    let mut project_files = vec![CONFIG_FILE.to_string()];
    project_files.extend(SKILL_FILES.iter().map(|n| format!("{CANONICAL_DIR}/{n}")));
    let mut contents = Vec::new();
    for rel in &project_files {
        match fs::read_to_string(repo.join(rel)) {
            Ok(text) => contents.push(text),
            Err(_) => return Ok(fail("installed-files", false, incident_ref)),
        }
    }

    // The skill's helper CLI (assets/agent-skill/SKILL.md).
    let args = [
        "context".to_string(),
        "--ref".to_string(),
        incident_ref.clone(),
        "--format".to_string(),
        "json".to_string(),
    ];
    let output = runner.run(&helper, &args, &repo)?;
    let canary = contains_secret(&output.stdout)
        || contains_secret(&output.stderr)
        || contents.iter().any(|c| contains_secret(c));
    if canary {
        return Ok(fail("canary-scan", true, incident_ref));
    }
    if !output.success {
        return Ok(fail("helper-run", false, incident_ref));
    }
    if serde_json::from_str::<serde_json::Value>(&output.stdout)
        .map(|v| !v.is_object())
        .unwrap_or(true)
    {
        return Ok(fail("parse-context", false, incident_ref));
    }
    Ok(AgentVerifyResult {
        ok: true,
        failed_step: None,
        canary_found: false,
        incident_ref,
    })
}

// ------------------------------------------------------------------ commands

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| AgentError::WriteFailed.code().to_string())
}

fn skill_source(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map(|d| d.join("_up_/_up_/_up_/assets/agent-skill"))
        .ok();
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../assets/agent-skill");
    [bundled, Some(dev)]
        .into_iter()
        .flatten()
        .find(|p| p.join("SKILL.md").is_file())
        .ok_or_else(|| AgentError::SkillSourceMissing.code().to_string())
}


#[tauri::command]
pub fn agent_install_preview(
    app: tauri::AppHandle,
    request: AgentInstallRequest,
) -> Result<AgentInstallPreview, String> {
    preview_install(&request, &skill_source(&app)?, &home_dir()?).map_err(|e| e.code().to_string())
}

#[tauri::command]
pub fn agent_install(
    app: tauri::AppHandle,
    request: AgentInstallRequest,
) -> Result<AgentInstallResult, String> {
    install(
        &request,
        &skill_source(&app)?,
        &home_dir()?,
        std::env::current_exe().ok().as_deref(),
    )
    .map_err(|e| e.code().to_string())
}

#[tauri::command]
pub fn agent_verify(request: AgentInstallRequest) -> Result<AgentVerifyResult, String> {
    verify(&request, &home_dir()?, &ProcessRunner).map_err(|e| e.code().to_string())
}

// --------------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(label: &str) -> Tmp {
            let root = std::env::temp_dir().join(format!("agent-install-{label}-{}", unique_suffix()));
            fs::create_dir_all(&root).unwrap();
            Tmp(root)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture_skill(root: &Path, body: &str) -> PathBuf {
        let dir = root.join("skill");
        fs::create_dir_all(dir.join("references")).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {SKILL_NAME}\n---\n{body}\n"),
        )
        .unwrap();
        fs::write(dir.join("references/evidence-policy.md"), "policy\n").unwrap();
        dir
    }

    fn git_repo(root: &Path) -> PathBuf {
        let repo = root.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::canonicalize(repo).unwrap()
    }

    fn request(repo: &Path, providers: Vec<AgentProvider>) -> AgentInstallRequest {
        AgentInstallRequest {
            workspace_id: "ws-1".into(),
            application_id: "app-1".into(),
            repository_path: repo.to_string_lossy().into_owned(),
            providers,
            project_slug: "web".into(),
            glitchtip_base_url: "https://glitchtip.example.com".into(),
        }
    }

    #[test]
    fn agent_install_rejects_repository_without_git() {
        let tmp = Tmp::new("nogit");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = tmp.path().join("plain");
        fs::create_dir_all(&repo).unwrap();
        let err = preview_install(&request(&repo, vec![]), &skill, tmp.path()).unwrap_err();
        assert_eq!(err, AgentError::NotAGitRepository);
    }

    #[test]
    fn agent_install_rejects_symlink_escaping_repository() {
        let tmp = Tmp::new("escape");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, repo.join(".agents")).unwrap();
        let err = preview_install(&request(&repo, vec![]), &skill, tmp.path()).unwrap_err();
        assert_eq!(err, AgentError::SymlinkEscape);
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn agent_install_rejects_foreign_skill_directory() {
        let tmp = Tmp::new("foreign");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let dir = repo.join(CANONICAL_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: someone-else\n---\n").unwrap();
        let err = preview_install(&request(&repo, vec![]), &skill, tmp.path()).unwrap_err();
        assert_eq!(err, AgentError::ForeignSkillDirectory);
    }

    #[test]
    fn agent_install_rejects_secret_canary_in_preview() {
        let tmp = Tmp::new("canary");
        let skill = fixture_skill(tmp.path(), "token sntrys_abc123");
        let repo = git_repo(tmp.path());
        let err = preview_install(&request(&repo, vec![]), &skill, tmp.path()).unwrap_err();
        assert_eq!(err, AgentError::SecretInPreview);
    }

    #[test]
    fn agent_install_detects_dsn_and_bearer() {
        assert!(contains_secret("https://abc123@o1.ingest.example.com/5"));
        assert!(contains_secret("Authorization: Bearer x"));
        assert!(!contains_secret("https://glitchtip.example.com/issues/1"));
    }

    #[test]
    fn agent_install_preview_reports_create_then_unchanged_then_update() {
        let tmp = Tmp::new("preview");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let req = request(&repo, vec![AgentProvider::Codex, AgentProvider::Claude]);

        let first = preview_install(&req, &skill, tmp.path()).unwrap();
        assert_eq!(first.files.len(), 5);
        assert!(first.files.iter().all(|f| f.action == FileAction::Create));
        assert!(!first.requires_confirmation);
        assert!(first.helper_path.ends_with(
            "Library/Application Support/dev.ctimothe.glitchtip-onboarding/bin/glitchtip-companion"
        ));

        install(&req, &skill, tmp.path(), None).unwrap();
        let second = preview_install(&req, &skill, tmp.path()).unwrap();
        assert!(second.files.iter().all(|f| f.action == FileAction::Unchanged));
        assert!(!second.requires_confirmation);

        let changed = fixture_skill(tmp.path(), "v2");
        let third = preview_install(&req, &changed, tmp.path()).unwrap();
        let skill_entry = third
            .files
            .iter()
            .find(|f| f.path.ends_with("SKILL.md"))
            .unwrap();
        assert_eq!(skill_entry.action, FileAction::Update);
        assert_eq!(skill_entry.diff.as_deref(), Some("-v1\n+v2"));
        assert!(third.requires_confirmation);
    }

    #[test]
    fn agent_install_writes_files_and_relative_symlinks() {
        let tmp = Tmp::new("write");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let req = request(&repo, vec![AgentProvider::Codex, AgentProvider::Claude]);
        let result = install(&req, &skill, tmp.path(), None).unwrap();
        assert_eq!(result.installed.len(), 5);
        assert!(result.unchanged.is_empty());
        assert!(!result.helper_installed);

        let config: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(repo.join(CONFIG_FILE)).unwrap()).unwrap();
        let mut keys: Vec<&String> = config.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            ["applicationId", "generatedFileVersion", "glitchtipBaseUrl", "projectSlug", "schemaVersion", "workspaceId"]
        );
        for link in [".codex/skills/glitchtip-investigate", ".claude/skills/glitchtip-investigate"] {
            let path = repo.join(link);
            assert_eq!(
                fs::read_link(&path).unwrap(),
                Path::new("../../.agents/skills/glitchtip-investigate")
            );
            assert!(path.join("SKILL.md").is_file());
        }
        let leftovers: Vec<_> = fs::read_dir(&repo)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("staging"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn agent_install_other_provider_adds_no_symlink() {
        let tmp = Tmp::new("other");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        install(&request(&repo, vec![AgentProvider::Other]), &skill, tmp.path(), None).unwrap();
        assert!(!repo.join(".codex").exists());
        assert!(!repo.join(".claude").exists());
    }

    #[test]
    fn agent_install_writes_a_launcher_for_the_app_with_mode_0755() {
        let tmp = Tmp::new("helper");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let exe = Path::new("/Applications/GlitchTip Companion.app/Contents/MacOS/it's-the-app");
        let home = tmp.path().join("home");
        let result = install(&request(&repo, vec![]), &skill, &home, Some(exe)).unwrap();
        assert!(result.helper_installed);
        let mode = fs::metadata(helper_target(&home)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(
            fs::read_to_string(helper_target(&home)).unwrap().lines().last(),
            Some("exec '/Applications/GlitchTip Companion.app/Contents/MacOS/it'\\''s-the-app' --companion-helper \"$@\"")
        );
    }

    #[test]
    fn agent_install_launcher_runs_the_app_as_the_helper_with_every_argument() {
        let tmp = Tmp::new("launcher");
        let app = tmp.path().join("fake app");
        fs::write(&app, "#!/bin/sh\nprintf '%s|' \"$@\"\n").unwrap();
        fs::set_permissions(&app, fs::Permissions::from_mode(0o755)).unwrap();
        let target = tmp.path().join("bin/glitchtip-companion");
        install_launcher(&app, &target).unwrap();
        let out = Command::new(&target).args(["context", "--ref", "gt:web:1", "--format", "json"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "--companion-helper|context|--ref|gt:web:1|--format|json|");
    }

    #[test]
    fn agent_install_refuses_a_launcher_for_a_translocated_app() {
        let tmp = Tmp::new("translocated");
        let exe = Path::new("/private/var/folders/x/AppTranslocation/ABC/d/GlitchTip Companion.app/Contents/MacOS/app");
        let target = tmp.path().join("bin/glitchtip-companion");
        assert_eq!(install_launcher(exe, &target).unwrap_err(), AgentError::AppTranslocated);
        assert!(!target.exists());
    }

    struct FakeRunner {
        out: HelperOutput,
        seen: RefCell<Vec<String>>,
    }
    impl HelperRunner for FakeRunner {
        fn run(&self, _: &Path, args: &[String], _: &Path) -> Result<HelperOutput, AgentError> {
            self.seen.replace(args.to_vec());
            Ok(HelperOutput {
                success: self.out.success,
                stdout: self.out.stdout.clone(),
                stderr: self.out.stderr.clone(),
            })
        }
    }

    fn installed_with_helper(tmp: &Tmp) -> (AgentInstallRequest, PathBuf) {
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let home = tmp.path().join("home");
        fs::create_dir_all(helper_target(&home).parent().unwrap()).unwrap();
        fs::write(helper_target(&home), "x").unwrap();
        let req = request(&repo, vec![AgentProvider::Codex]);
        install(&req, &skill, &home, None).unwrap();
        (req, home)
    }

    fn runner(success: bool, stdout: &str, stderr: &str) -> FakeRunner {
        FakeRunner {
            out: HelperOutput { success, stdout: stdout.into(), stderr: stderr.into() },
            seen: RefCell::new(Vec::new()),
        }
    }

    #[test]
    fn agent_install_verify_passes_with_clean_context() {
        let tmp = Tmp::new("verify-ok");
        let (req, home) = installed_with_helper(&tmp);
        let r = runner(true, "{\"issue\":\"x\"}", "");
        let result = verify(&req, &home, &r).unwrap();
        assert!(result.ok);
        assert_eq!(result.failed_step, None);
        assert!(!result.canary_found);
        assert_eq!(result.incident_ref, format!("gt:{}:test", req.application_id));
        assert!(r.seen.borrow().contains(&result.incident_ref));
    }

    #[test]
    fn agent_install_verify_reports_canary_in_output() {
        let tmp = Tmp::new("verify-canary");
        let (req, home) = installed_with_helper(&tmp);
        let result = verify(&req, &home, &runner(true, "{\"k\":\"COMPANION_CANARY_1\"}", "")).unwrap();
        assert!(!result.ok);
        assert!(result.canary_found);
        assert_eq!(result.failed_step.as_deref(), Some("canary-scan"));
        let result = verify(&req, &home, &runner(true, "{}", "Bearer abc")).unwrap();
        assert!(result.canary_found);
    }

    #[test]
    fn agent_install_verify_reports_failed_steps() {
        let tmp = Tmp::new("verify-fail");
        let (req, home) = installed_with_helper(&tmp);
        let result = verify(&req, &home, &runner(false, "", "boom")).unwrap();
        assert_eq!(result.failed_step.as_deref(), Some("helper-run"));
        let result = verify(&req, &home, &runner(true, "not json", "")).unwrap();
        assert_eq!(result.failed_step.as_deref(), Some("parse-context"));
    }

    #[test]
    fn agent_install_verify_requires_installed_helper() {
        let tmp = Tmp::new("verify-nohelper");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let req = request(&repo, vec![]);
        install(&req, &skill, tmp.path(), None).unwrap();
        let err = verify(&req, tmp.path(), &runner(true, "{}", "")).unwrap_err();
        assert_eq!(err, AgentError::HelperNotInstalled);
        assert_eq!(err.code(), "helper-not-installed");
    }

    #[test]
    fn agent_install_rejects_bad_identifiers() {
        let tmp = Tmp::new("ids");
        let skill = fixture_skill(tmp.path(), "v1");
        let repo = git_repo(tmp.path());
        let mut req = request(&repo, vec![]);
        req.workspace_id = "../x".into();
        assert_eq!(preview_install(&req, &skill, tmp.path()).unwrap_err(), AgentError::InvalidRequest);
    }
}
