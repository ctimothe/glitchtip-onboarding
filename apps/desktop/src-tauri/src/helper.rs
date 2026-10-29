// The context helper coding agents run:
//
//     glitchtip-companion context --ref gt:<application>:<issue> --format json
//
// The app's own executable answers it. `agent_install` writes a launcher script at the fixed helper
// path that starts this executable with `LAUNCH_FLAG`, and `main` hands those runs here before any
// window exists. Being the app, it reads the GlitchTip token from the Keychain item the app created
// without asking for a new permission.
//
// It prints one sanitized JSON object, or exits with the code the investigate skill expects:
// 2 configuration, 3 credential, 4 network or API, 5 sanitization, and one line on stderr naming
// the failed step. Nothing it prints ever carries the token.
//
// Trust: the repository's `.glitchtip-companion.json` only says which workspace and application
// the checkout belongs to, and the app answers only for the application installed at that checkout.
// The GlitchTip address, organization and project come from the app's own workspace file, found
// through the user database rather than `HOME`, so neither a repository nor whoever starts the
// helper can send the token to another host or read another project's issues. Requests go out
// through /usr/bin/curl with an empty environment and no curl config, over HTTPS only, without
// following redirects, with the Authorization header passed on stdin rather than the command line.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Map, Value};

use crate::agent_install::{contains_secret, CONFIG_FILE};
use crate::keychain::{get_secret, MacKeychain, SecretError, SERVICE};

/// The first argument that makes the app answer as the helper instead of opening its window.
pub const LAUNCH_FLAG: &str = "--companion-helper";

const APP_DATA_DIR: &str = "Library/Application Support/dev.ctimothe.glitchtip-onboarding";
const WORKSPACE_FILE: &str = "workspace.json";
const TOKEN_KEY: &str = "glitchtip-token";
const CURL: &str = "/usr/bin/curl";
/// Frames kept per exception, the innermost ones.
const MAX_FRAMES: usize = 40;
const MAX_TEXT: usize = 500;

/// A failed step: the skill's exit code and the name printed on stderr.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub exit: i32,
    pub step: String,
}

fn config(step: &str) -> Failure {
    Failure { exit: 2, step: step.into() }
}
fn credential(step: &str) -> Failure {
    Failure { exit: 3, step: step.into() }
}
fn network(step: impl Into<String>) -> Failure {
    Failure { exit: 4, step: step.into() }
}

/// What the helper reads from the machine, so every step is tested without one.
pub trait HelperEnv {
    fn cwd(&self) -> Option<PathBuf>;
    /// The user's home directory from the user database, never from the environment.
    fn home(&self) -> Option<PathBuf>;
    fn read(&self, path: &Path) -> Option<String>;
    /// `path` with every symlink resolved, or None when it does not exist.
    fn canonical(&self, path: &Path) -> Option<PathBuf>;
    fn token(&self, workspace_id: &str) -> Result<Option<String>, SecretError>;
    /// GET `url` with the token: the HTTP status and body, or None when nothing answered.
    fn get(&self, url: &str, token: &str) -> Option<(u16, String)>;
}

/// Runs the helper: the exit code, what goes to stdout, and what goes to stderr.
pub fn run(args: &[String], env: &dyn HelperEnv) -> (i32, String, String) {
    match context(args, env) {
        Ok(value) => {
            let text = serde_json::to_string_pretty(&value).unwrap_or_default();
            // The last guard: anything that still looks like a credential is not printed at all.
            if contains_secret(&text) {
                return (5, String::new(), "glitchtip-companion: unsafe-context\n".into());
            }
            (0, format!("{text}\n"), String::new())
        }
        Err(failure) => (failure.exit, String::new(), format!("glitchtip-companion: {}\n", failure.step)),
    }
}

/// Entry point from `main`: prints and returns the exit code.
pub fn main(args: &[String]) -> i32 {
    let (code, stdout, stderr) = run(args, &SystemEnv);
    let _ = std::io::stdout().write_all(stdout.as_bytes());
    let _ = std::io::stderr().write_all(stderr.as_bytes());
    code
}

struct Reference {
    application: String,
    /// A GlitchTip issue id, or None for a Companion test event, which has no issue.
    issue: Option<String>,
}

fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// `gt:<application id or project slug>:<issue id>`, as the relay writes it (assets/relay/domain.js
// `incidentReference`). A test event has no issue: its last part is `test`, or `unknown`.
fn parse_reference(text: &str) -> Option<Reference> {
    let mut parts = text.split(':');
    let (Some("gt"), Some(application), Some(issue), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if !identifier(application, 64) {
        return None;
    }
    let issue = match issue {
        "test" | "unknown" => None,
        id if !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit()) => Some(id.to_string()),
        _ => return None,
    };
    Some(Reference { application: application.into(), issue })
}

fn parse_args(args: &[String]) -> Result<Reference, Failure> {
    let mut reference = None;
    let mut format = None;
    let mut rest = args.iter();
    if rest.next().map(String::as_str) != Some("context") {
        return Err(config("usage"));
    }
    while let Some(flag) = rest.next() {
        let value = rest.next().ok_or_else(|| config("usage"))?;
        match flag.as_str() {
            "--ref" if reference.is_none() => reference = Some(value.clone()),
            "--format" if format.is_none() => format = Some(value.clone()),
            _ => return Err(config("usage")),
        }
    }
    if format.as_deref() != Some("json") {
        return Err(config("format-unsupported"));
    }
    parse_reference(&reference.ok_or_else(|| config("usage"))?).ok_or_else(|| config("reference-invalid"))
}

struct RepositoryConfig {
    workspace_id: String,
    application_id: String,
    /// The directory holding the config file.
    dir: PathBuf,
}

/// The nearest `.glitchtip-companion.json` from the working directory up to the repository root.
fn repository_config(env: &dyn HelperEnv) -> Result<RepositoryConfig, Failure> {
    let mut dir = env.cwd().ok_or_else(|| config("config-not-found"))?;
    let text = loop {
        if let Some(text) = env.read(&dir.join(CONFIG_FILE)) {
            break text;
        }
        // `.git` is a directory in a checkout and a file in a linked worktree.
        let root = env.read(&dir.join(".git/HEAD")).is_some() || env.read(&dir.join(".git")).is_some();
        if root || !dir.pop() {
            return Err(config("config-not-found"));
        }
    };
    let value: Value = serde_json::from_str(&text).map_err(|_| config("config-invalid"))?;
    let field = |name: &str| value.get(name).and_then(Value::as_str).filter(|v| identifier(v, 128)).map(str::to_string);
    match (field("workspaceId"), field("applicationId")) {
        (Some(workspace_id), Some(application_id)) => Ok(RepositoryConfig { workspace_id, application_id, dir }),
        _ => Err(config("config-invalid")),
    }
}

struct Target {
    base_url: String,
    organization: String,
    application_id: String,
    project_slug: String,
    /// Where the app installed the agent integration for this application.
    repository_path: Option<String>,
}

/// The GlitchTip address and project from the app's own workspace file.
fn workspace_target(env: &dyn HelperEnv, workspace_id: &str, application_id: &str) -> Result<Target, Failure> {
    let home = env.home().ok_or_else(|| config("workspace-not-found"))?;
    let text = env
        .read(&home.join(APP_DATA_DIR).join(WORKSPACE_FILE))
        .ok_or_else(|| config("workspace-not-found"))?;
    let store: Value = serde_json::from_str(&text).map_err(|_| config("workspace-invalid"))?;
    let workspace = store.get("workspace").filter(|w| w.get("id").and_then(Value::as_str) == Some(workspace_id));
    let workspace = workspace.ok_or_else(|| config("workspace-not-found"))?;
    let text_at = |value: &Value, pointer: &str| value.pointer(pointer).and_then(Value::as_str).map(str::to_string);
    let base_url = text_at(workspace, "/glitchtip/baseUrl").unwrap_or_default();
    let organization = text_at(workspace, "/glitchtip/organizationSlug").unwrap_or_default();
    if !base_url.starts_with("https://") || base_url.contains(char::is_whitespace) || !identifier(&organization, 128) {
        return Err(config("workspace-invalid"));
    }
    let application = workspace
        .get("applications")
        .and_then(Value::as_array)
        .and_then(|apps| apps.iter().find(|a| a.get("id").and_then(Value::as_str) == Some(application_id)))
        .ok_or_else(|| config("application-not-found"))?;
    let project_slug = text_at(application, "/projectSlug").filter(|s| identifier(s, 128));
    Ok(Target {
        base_url: base_url.trim_end_matches('/').to_string(),
        organization,
        application_id: application_id.into(),
        project_slug: project_slug.ok_or_else(|| config("workspace-invalid"))?,
        repository_path: text_at(application, "/repositoryPath"),
    })
}

fn fetch(env: &dyn HelperEnv, token: &str, url: &str, step: &str) -> Result<Value, Failure> {
    let (status, body) = env.get(url, token).ok_or_else(|| network(format!("{step}-unreachable")))?;
    if status == 401 || status == 403 {
        return Err(credential("credential-rejected"));
    }
    if !(200..300).contains(&status) {
        return Err(network(format!("{step}-http-{status}")));
    }
    serde_json::from_str(&body).map_err(|_| network(format!("{step}-invalid")))
}

fn context(args: &[String], env: &dyn HelperEnv) -> Result<Value, Failure> {
    let reference = parse_args(args)?;
    let repository = repository_config(env)?;
    let target = workspace_target(env, &repository.workspace_id, &repository.application_id)?;
    // A config copied into another checkout, or edited to name another application, is not the
    // one the app installed.
    let installed_at = target.repository_path.as_deref().and_then(|path| env.canonical(Path::new(path)));
    if installed_at.is_none() || installed_at != env.canonical(&repository.dir) {
        return Err(config("repository-mismatch"));
    }
    if reference.application != target.application_id && reference.application != target.project_slug {
        return Err(config("reference-mismatch"));
    }
    let token = match env.token(&repository.workspace_id) {
        Ok(Some(token)) => token,
        Ok(None) | Err(SecretError::NotFound) => return Err(credential("credential-missing")),
        Err(_) => return Err(credential("credential-denied")),
    };
    let reference_text = format!(
        "gt:{}:{}",
        reference.application,
        reference.issue.as_deref().unwrap_or("test")
    );
    let application = json!({ "id": target.application_id, "projectSlug": target.project_slug });

    let Some(issue_id) = reference.issue else {
        // A test event: the reference resolved and GlitchTip answers with this token.
        let url = format!("{}/api/0/organizations/{}/", target.base_url, target.organization);
        fetch(env, &token, &url, "organization")?;
        return Ok(json!({
            "schemaVersion": 1,
            "reference": reference_text,
            "state": "test",
            "application": application,
            "issue": null,
            "event": null,
        }));
    };

    let issue = fetch(env, &token, &format!("{}/api/0/issues/{issue_id}/", target.base_url), "issue")?;
    // An issue of another project is not this application's, whatever the reference says.
    if issue.pointer("/project/slug").and_then(Value::as_str) != Some(target.project_slug.as_str()) {
        return Err(config("issue-not-in-project"));
    }
    let event = fetch(
        env,
        &token,
        &format!("{}/api/0/issues/{issue_id}/events/latest/", target.base_url),
        "event",
    )?;
    Ok(json!({
        "schemaVersion": 1,
        "reference": reference_text,
        "state": state_of(&issue),
        "application": application,
        "issue": issue_summary(&issue),
        "event": event_summary(&event),
    }))
}

// ------------------------------------------------------------------ sanitize

fn state_of(issue: &Value) -> &'static str {
    match (issue.get("status").and_then(Value::as_str), issue.get("level").and_then(Value::as_str)) {
        (Some("resolved"), _) => "resolved",
        (_, Some("warning")) => "warning",
        (_, Some("info")) => "info",
        _ => "error",
    }
}

fn number(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        Some(Value::String(s)) => s.parse::<u64>().map(Value::from).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn text(value: Option<&Value>) -> Value {
    value.and_then(Value::as_str).map(|s| Value::from(redact(s))).unwrap_or(Value::Null)
}

/// Fields of a plain kind copied as they are: identifiers, times, levels.
fn plain(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(s)) if s.len() <= 64 && !s.contains(char::is_whitespace) => Value::from(s.as_str()),
        Some(Value::Number(n)) => Value::from(n.to_string()),
        _ => Value::Null,
    }
}

fn issue_summary(issue: &Value) -> Value {
    json!({
        "id": plain(issue.get("id")),
        "title": text(issue.get("title")),
        "culprit": text(issue.get("culprit")),
        "level": plain(issue.get("level")),
        "status": plain(issue.get("status")),
        "count": number(issue.get("count")),
        "userCount": number(issue.get("userCount")),
        "firstSeen": plain(issue.get("firstSeen")),
        "lastSeen": plain(issue.get("lastSeen")),
    })
}

fn tag(event: &Value, key: &str) -> Value {
    event
        .get("tags")
        .and_then(Value::as_array)
        .and_then(|tags| tags.iter().find(|t| t.get("key").and_then(Value::as_str) == Some(key)))
        .map(|t| text(t.get("value")))
        .unwrap_or(Value::Null)
}

fn frame_summary(frame: &Value) -> Value {
    let line = |key: &str| frame.get(key).and_then(Value::as_u64).map(Value::from).unwrap_or(Value::Null);
    json!({
        "filename": text(frame.get("filename")),
        "function": text(frame.get("function")),
        "module": text(frame.get("module")),
        "lineNo": line("lineNo"),
        "colNo": line("colNo"),
        "inApp": frame.get("inApp").and_then(Value::as_bool).unwrap_or(false),
    })
}

// Only exception types, messages and frame locations: never variables, source context, request,
// user, breadcrumbs or other tags, which is where payloads carry personal data and secrets.
fn event_summary(event: &Value) -> Value {
    let exceptions: Vec<Value> = event
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("exception"))
        .filter_map(|entry| entry.pointer("/data/values").and_then(Value::as_array))
        .flatten()
        .map(|exception| {
            let frames: Vec<Value> = exception
                .pointer("/stacktrace/frames")
                .and_then(Value::as_array)
                .map(|frames| {
                    let skip = frames.len().saturating_sub(MAX_FRAMES);
                    frames.iter().skip(skip).map(frame_summary).collect()
                })
                .unwrap_or_default();
            let mut summary = Map::new();
            summary.insert("type".into(), text(exception.get("type")));
            summary.insert("value".into(), text(exception.get("value")));
            summary.insert("module".into(), text(exception.get("module")));
            summary.insert("frames".into(), Value::from(frames));
            Value::Object(summary)
        })
        .collect();
    json!({
        "id": plain(event.get("eventID").or_else(|| event.get("id"))),
        "dateCreated": plain(event.get("dateCreated")),
        "release": tag(event, "release"),
        "environment": tag(event, "environment"),
        "exceptions": exceptions,
    })
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=')
}

/// Field names whose value is a credential, matched at the end of the name in any case:
/// `password=…`, `"api_key": "…"`, `X-Auth-Token: …`.
const CREDENTIAL_NAMES: [&str; 15] = [
    "password",
    "passwd",
    "pwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "api-key",
    "access_key",
    "private_key",
    "auth",
    "authorization",
    "cookie",
    "session",
    "credentials",
];
const REDACTED: &str = "[redacted]";

/// Text from an event with what reads as personal data or a secret replaced by `[redacted]`:
/// email addresses, phone numbers, IPv4 addresses, credentials and query strings in URLs, labelled
/// credentials, bearer values, and long token-like runs. Names written as plain words are not
/// recognizable and stay.
pub fn redact(input: &str) -> String {
    // URLs carrying credentials go whole first, then labelled credentials, on the text as written,
    // so no other rule has yet put a `[redacted]` into the middle of a value or taken a URL's `@`.
    let urls = map_runs(input, is_url_separator, |run| has_url_credentials(bare_word(run)).then(|| REDACTED.to_string()));
    let numbers = redact_grouped_numbers(&redact_spaced_phones(&redact_labelled(&urls)));
    let mut text = map_runs(&numbers, is_separator, redact_run);
    // The value after "Bearer" and a space or tab is a credential, whatever it looks like.
    let mut from = 0;
    while let Some(i) = text.to_ascii_lowercase()[from..].find("bearer").map(|i| from + i) {
        let value = text.len() - text[i + 6..].trim_start_matches([' ', '\t']).len();
        if value == i + 6 {
            from = value;
            continue;
        }
        let end = text[value..].find(char::is_whitespace).map_or(text.len(), |e| value + e);
        text.replace_range(i..end, REDACTED);
        from = i + REDACTED.len();
    }
    if text.chars().count() > MAX_TEXT {
        text = text.chars().take(MAX_TEXT).collect::<String>() + "…";
    }
    text
}

/// What separates the runs judged one at a time: whitespace, and the quotes, brackets and commas
/// around values in prose and in compact JSON such as `{"email":"jane@example.com"}`.
fn is_separator(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '{' | '}' | '[' | ']' | '(' | ')' | '<' | '>' | ',' | ';')
}

/// The same, less brackets, which a URL's password may hold.
fn is_url_separator(c: char) -> bool {
    is_separator(c) && !matches!(c, '(' | ')')
}

/// `text` with each run between separators replaced where `judge` gives a replacement.
fn map_runs(text: &str, separator: fn(char) -> bool, judge: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0;
    let flush = |out: &mut String, word: &str| match judge(word).filter(|_| !word.is_empty()) {
        Some(replacement) => out.push_str(&replacement),
        None => out.push_str(word),
    };
    for (i, c) in text.char_indices() {
        if separator(c) {
            flush(&mut out, &text[run..i]);
            out.push(c);
            run = i + c.len_utf8();
        }
    }
    flush(&mut out, &text[run..]);
    out
}

/// The replacement for one run that reads as personal data or a secret, whole or after a
/// `key=` or `key:` as logfmt and key/value logs write it (`ip=192.168.1.20`).
fn redact_run(word: &str) -> Option<String> {
    let bare = bare_word(word);
    if sensitive(bare) {
        // The quotes, escapes and punctuation around it stay.
        let start = bare.as_ptr() as usize - word.as_ptr() as usize;
        return Some(format!("{}{REDACTED}{}", &word[..start], &word[start + bare.len()..]));
    }
    let Some(scheme) = bare.find("://") else {
        let i = word.find(['=', ':']).filter(|&i| sensitive(bare_word(&word[i + 1..])))?;
        return Some(format!("{}{REDACTED}", &word[..=i]));
    };
    let mut url = word.to_string();
    // An address as the host: `http://192.168.1.20:8080/`.
    let authority = bare[scheme + 3..].split(['/', '?', '#']).next().unwrap_or_default();
    if is_ipv4(authority) {
        url = url.replacen(authority, REDACTED, 1);
    }
    // A query string is where URLs carry tokens and signatures.
    if let Some(query) = url.find('?') {
        url = format!("{}?{REDACTED}", &url[..query]);
    }
    (url != word).then_some(url)
}

/// `192.168.1.20`, with or without a port.
fn is_ipv4(bare: &str) -> bool {
    let parts: Vec<&str> = bare.split(['.', ':']).collect();
    parts.len() >= 4 && parts[..4].iter().all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

/// Whether a bare run is an email address, a URL with credentials, an IPv4 address, a token or a
/// phone number.
fn sensitive(bare: &str) -> bool {
    // `name@host.tld` in any path segment, which a release such as `shop@2.4.1` and a scoped
    // package such as `/node_modules/@scope/pkg` are not.
    let is_email = bare.split('/').any(|segment| {
        let segment = segment.split(['?', '#']).next().unwrap_or_default();
        segment.find('@').is_some_and(|i| {
            let domain = &segment[i + 1..];
            i > 0
                && domain.contains('.')
                && domain.rsplit('.').next().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
        })
    });
    let long_token = bare.chars().count() >= 32
        && bare.chars().all(is_token_char)
        && bare.chars().any(|c| c.is_ascii_digit())
        && bare.chars().any(|c| c.is_ascii_alphabetic());
    let known = ["sntrys_", "sntryu_", "-----BEGIN"].iter().any(|m| bare.contains(m));
    // `+1-212-555-0147`, `212.555.0147` or `555-0123`, which a date such as `2026-10-29` and a
    // decimal such as `123.4567` are not.
    let digits = bare.chars().filter(char::is_ascii_digit).count();
    let groups: Vec<usize> = bare.split(['-', '.', '(', ')']).filter(|g| !g.is_empty()).map(str::len).collect();
    let local = groups == [3, 4] && bare.chars().all(|c| c.is_ascii_digit() || c == '-');
    let is_phone = !bare.is_empty()
        && bare.chars().all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | '(' | ')'))
        && ((bare.starts_with('+') && digits >= 8 && !signed_decimal(&bare.chars().collect::<Vec<_>>()))
            || phone_shaped(&groups)
            || local);
    is_email || has_url_credentials(bare) || is_ipv4(bare) || long_token || known || is_phone
}

/// A word without the brackets, quotes, escapes and punctuation around it.
fn bare_word(word: &str) -> &str {
    word.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '<' | '>' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '.' | '\\'))
}

/// `https://user:password@host/…`.
fn has_url_credentials(bare: &str) -> bool {
    bare.find("://").is_some_and(|i| {
        bare[i + 3..].split(['/', '?', '#']).next().is_some_and(|authority| authority.contains('@'))
    })
}

/// `name=value` and `name: value` pairs whose name is a credential's, with the value redacted. An
/// auth scheme such as `Bearer` takes the word after it along.
fn redact_labelled(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    // A value that opens with `[` holds its own `]`s and runs to the end of its word.
    let word_end = |from: usize| {
        let bracketed = chars.get(from) == Some(&'[');
        let mut end = from;
        while end < chars.len()
            && !chars[end].is_whitespace()
            && !matches!(chars[end], '"' | '\'' | '&' | ',' | ';' | ')' | '}')
            && !(chars[end] == ']' && !bracketed)
        {
            end += 1;
        }
        end
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        i += 1;
        if !matches!(c, '=' | ':') {
            continue;
        }
        let name = name_before(&chars[..i - 1]);
        if name.is_empty() || !CREDENTIAL_NAMES.iter().any(|credential| name.ends_with(credential)) {
            continue;
        }
        let mut start = i;
        while matches!(chars.get(start), Some(' ' | '\t')) {
            start += 1;
        }
        // `\"…\"`: text that was itself a JSON string keeps its quotes escaped.
        let escaped = chars.get(start) == Some(&'\\') && chars.get(start + 1).is_some_and(|c| matches!(c, '"' | '\''));
        if escaped {
            start += 1;
        }
        let quote = chars.get(start).copied().filter(|c| matches!(c, '"' | '\''));
        if quote.is_some() {
            start += 1;
        }
        // A quoted value runs, spaces and all, to the first quote escaped exactly as the opening one:
        // `"` after an even run of backslashes, `\"` after a single one. Any other quote is part of
        // the value, and a value never closed runs to the end.
        let mut end = match quote {
            Some(q) => {
                let backslashes = |e: usize| chars[start..e].iter().rev().take_while(|&&c| c == '\\').count();
                (start..chars.len())
                    .find(|&e| chars[e] == q && if escaped { backslashes(e) == 1 } else { backslashes(e) % 2 == 0 })
                    .map_or(chars.len(), |e| e - usize::from(escaped))
            }
            // A cookie header lists its cookies, `a=1; b=2`, up to the end of its line.
            None if name.ends_with("cookie") => {
                (start..chars.len()).find(|&e| matches!(chars[e], '\r' | '\n')).unwrap_or(chars.len())
            }
            None => word_end(start),
        };
        let value: String = chars[start..end].iter().collect();
        if end == start || value == REDACTED {
            continue;
        }
        let after = (end..chars.len()).find(|&e| !matches!(chars[e], ' ' | '\t')).unwrap_or(chars.len());
        if quote.is_none()
            && matches!(value.to_ascii_lowercase().as_str(), "bearer" | "basic" | "token" | "digest")
            && after > end
        {
            end = word_end(after);
        }
        out.extend(&chars[i..start]);
        out.push_str(REDACTED);
        i = end;
    }
    out
}

/// `+12.345678`: a sign, digits and one decimal point, which an international number is not. One
/// followed by more digits (`+12.345678 9`) is redacted, as `+1.212 555 0147` would be.
fn signed_decimal(chars: &[char]) -> bool {
    chars.iter().filter(|&&c| c == '.').count() == 1 && chars[1..].iter().all(|&c| c.is_ascii_digit() || c == '.')
}

/// International numbers written with spaces, such as `+998 90 123 45 67`.
fn redact_spaced_phones(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '+' && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
            let (mut end, mut last_digit, mut digits) = (i + 1, i, 0);
            while end < chars.len() && (chars[end].is_ascii_digit() || matches!(chars[end], ' ' | '-' | '.' | '(' | ')')) {
                if chars[end].is_ascii_digit() {
                    digits += 1;
                    last_digit = end;
                } else if chars[end] == ' ' && chars.get(end + 1) == Some(&' ') {
                    break;
                }
                end += 1;
            }
            if digits >= 8 && !signed_decimal(&chars[i..=last_digit]) {
                out.push_str(REDACTED);
                i = last_digit + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Digit groups shaped like a phone number without its country code: three or more groups, nine to
/// fifteen digits in all, and every group after the first of two to four digits, as in
/// `212 555 0147`, `90 123 45 67` or `8 912 345 67 89`. A date (`2026-10-29`) has too few digits,
/// and versions and decimals (`1.20261029.123`, `3.14 2.71`) have groups of the wrong length. A
/// version shaped exactly like a number (`1.2026.1029`) is redacted: a leaked number costs more.
fn phone_shaped(groups: &[usize]) -> bool {
    let digits: usize = groups.iter().sum();
    groups.len() >= 3 && (9..=15).contains(&digits) && groups[1..].iter().all(|g| (2..=4).contains(g))
}

/// Phone numbers without a country code that run across words, such as `212 555 0147` or
/// `(212) 555-0147`; one word alone is judged in `redact`.
fn redact_grouped_numbers(text: &str) -> String {
    const CLOSING: [char; 5] = [')', ',', ';', ':', '.'];
    // A word of digit groups joined by `-` or `.`, with an opening bracket or closing punctuation,
    // and whether that punctuation ends the run (`1001, 1002` is a list). A date is never part of one.
    let groups = |word: &str| -> Option<(Vec<usize>, bool)> {
        let bare = word.trim_start_matches('(').trim_end_matches(CLOSING);
        let digits_only = bare.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '.'));
        let groups: Vec<usize> = bare.split(['-', '.']).map(str::len).collect();
        let date = groups == [4, 2, 2] || groups == [2, 2, 4];
        let ends = word[word.len() - word.trim_start_matches('(').len() + bare.len()..].contains([',', ';', ':', '.']);
        (digits_only && !groups.contains(&0) && !date).then_some((groups, ends))
    };
    let words: Vec<&str> = text.split(' ').collect();
    let mut out: Vec<String> = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        // The longest run of number words from here that reads as a phone number.
        let (mut run, mut end, mut found) = (Vec::new(), i, None);
        while let Some((word_groups, ends)) = words.get(end).and_then(|word| groups(word)) {
            run.extend(word_groups);
            end += 1;
            if end - i >= 2 && phone_shaped(&run) {
                found = Some(end);
            }
            if ends {
                break;
            }
        }
        if let Some(end) = found {
            // Punctuation after the number belongs to the sentence.
            let last = words[end - 1];
            let tail = &last[last.trim_end_matches(CLOSING).len()..];
            out.push(format!("{REDACTED}{}", tail.trim_start_matches(')')));
            i = end;
        } else {
            out.push(words[i].to_string());
            i += 1;
        }
    }
    out.join(" ")
}

/// The field name, in lower case, that ends where `chars` ends: `password` in `password `,
/// `"password"` or `\"password\"`. The last part of a path counts too (`db/password`), so an
/// extensionless code path such as `src/auth:42` loses its line number rather than risk a leak.
fn name_before(chars: &[char]) -> String {
    let mut end = chars.len();
    while end > 0 && matches!(chars[end - 1], ' ' | '\t') {
        end -= 1;
    }
    if end > 0 && matches!(chars[end - 1], '"' | '\'') {
        end -= 1;
        if end > 0 && chars[end - 1] == '\\' {
            end -= 1;
        }
    }
    let mut start = end;
    while start > 0 && (chars[start - 1].is_ascii_alphanumeric() || matches!(chars[start - 1], '_' | '-' | '.')) {
        start -= 1;
    }
    chars[start..end].iter().collect::<String>().to_ascii_lowercase()
}

// ---------------------------------------------------------------- the system

struct SystemEnv;

impl HelperEnv for SystemEnv {
    fn cwd(&self) -> Option<PathBuf> {
        std::env::current_dir().ok()
    }

    fn home(&self) -> Option<PathBuf> {
        use std::ffi::{CStr, OsStr};
        use std::os::unix::ffi::OsStrExt;
        // Whoever starts the helper can set HOME, and with it the workspace file that names the
        // host the token goes to; the user database cannot be changed that way.
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        // SAFETY: every pointer is to a live local, and `buffer.len()` is the buffer's real size.
        let status =
            unsafe { libc::getpwuid_r(libc::getuid(), &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut found) };
        if status != 0 || found.is_null() || entry.pw_dir.is_null() {
            return None;
        }
        // SAFETY: getpwuid_r succeeded, so `pw_dir` is a NUL-terminated string inside `buffer`.
        let dir = unsafe { CStr::from_ptr(entry.pw_dir) };
        Some(PathBuf::from(OsStr::from_bytes(dir.to_bytes()))).filter(|p| p.is_absolute())
    }

    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn canonical(&self, path: &Path) -> Option<PathBuf> {
        std::fs::canonicalize(path).ok()
    }

    fn token(&self, workspace_id: &str) -> Result<Option<String>, SecretError> {
        get_secret(&MacKeychain::new(SERVICE), workspace_id, TOKEN_KEY)
    }

    fn get(&self, url: &str, token: &str) -> Option<(u16, String)> {
        let mut child = curl(url).spawn().ok()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(format!("Authorization: Bearer {token}\n").as_bytes()).ok()?;
        }
        let output = child.wait_with_output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        let (body, status) = text.rsplit_once('\n')?;
        let status: u16 = status.trim().parse().ok()?;
        (status != 0).then(|| (status, body.to_string()))
    }
}

/// A GET of `url` that reads the Authorization header from stdin.
fn curl(url: &str) -> Command {
    // No environment and `--disable` (which must come first): curl then reads no `.curlrc`, CA
    // bundle or proxy setting that whoever starts the helper could supply.
    let mut command = Command::new(CURL);
    command
        .env_clear()
        .args([
                "--disable",
                "--silent",
                "--max-time",
                "6",
                "--proto",
                "=https",
                "--header",
                "@-",
                "--header",
                "Accept: application/json",
                "--write-out",
                "\n%{http_code}",
                "--",
                url,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    const HOME: &str = "/Users/dev";
    const REPO: &str = "/Users/dev/code/shop";

    struct Fake {
        cwd: PathBuf,
        files: BTreeMap<PathBuf, String>,
        token: Result<Option<String>, SecretError>,
        responses: BTreeMap<String, (u16, String)>,
        requests: RefCell<Vec<String>>,
    }

    impl HelperEnv for Fake {
        fn cwd(&self) -> Option<PathBuf> {
            Some(self.cwd.clone())
        }
        fn home(&self) -> Option<PathBuf> {
            Some(PathBuf::from(HOME))
        }
        fn read(&self, path: &Path) -> Option<String> {
            self.files.get(path).cloned()
        }
        fn canonical(&self, path: &Path) -> Option<PathBuf> {
            // `/Users/dev/shop` is a symlink to the checkout.
            let path = path.strip_prefix("/Users/dev/shop").map(|rest| Path::new(REPO).join(rest)).unwrap_or(path.into());
            path.starts_with("/Users/dev").then_some(path)
        }
        fn token(&self, _workspace_id: &str) -> Result<Option<String>, SecretError> {
            self.token.clone()
        }
        fn get(&self, url: &str, token: &str) -> Option<(u16, String)> {
            assert_eq!(token, "gt-token-value");
            self.requests.borrow_mut().push(url.to_string());
            self.responses.get(url).cloned()
        }
    }

    fn workspace() -> Value {
        json!({ "workspace": {
            "id": "ws-1",
            "glitchtip": { "baseUrl": "https://gt.example.com/", "organizationSlug": "acme" },
            "applications": [
                { "id": "web", "projectSlug": "shop-web", "repositoryPath": "/Users/dev/shop" },
                { "id": "billing", "projectSlug": "billing", "repositoryPath": "/Users/dev/code/billing" },
            ],
        }})
    }

    fn fake() -> Fake {
        let mut files = BTreeMap::new();
        files.insert(
            PathBuf::from(REPO).join(CONFIG_FILE),
            json!({ "workspaceId": "ws-1", "applicationId": "web", "glitchtipBaseUrl": "https://evil.example" }).to_string(),
        );
        files.insert(PathBuf::from(REPO).join(".git/HEAD"), "ref: refs/heads/main\n".into());
        files.insert(PathBuf::from(HOME).join(APP_DATA_DIR).join(WORKSPACE_FILE), workspace().to_string());
        let mut responses = BTreeMap::new();
        responses.insert(
            "https://gt.example.com/api/0/issues/1842/".into(),
            (200, json!({
                "id": 1842, "title": "TypeError: cannot read 'id' of undefined for jane@shop.example",
                "culprit": "checkout/pay", "level": "error", "status": "unresolved", "count": "12", "userCount": 3,
                "firstSeen": "2026-10-28T10:00:00Z", "lastSeen": "2026-10-29T09:00:00Z",
                "project": { "slug": "shop-web" },
            }).to_string()),
        );
        responses.insert(
            "https://gt.example.com/api/0/issues/1842/events/latest/".into(),
            (200, json!({
                "eventID": "abc123", "dateCreated": "2026-10-29T09:00:00Z",
                "tags": [
                    { "key": "environment", "value": "production" },
                    { "key": "release", "value": "shop@2.4.1" },
                    { "key": "user.email", "value": "jane@shop.example" },
                ],
                "entries": [
                    { "type": "exception", "data": { "values": [{
                        "type": "TypeError",
                        "value": "cannot read 'id' from 10.0.0.12 with Bearer sk_live_abcdef",
                        "stacktrace": { "frames": [{
                            "filename": "src/checkout/pay.ts", "function": "pay", "lineNo": 42, "colNo": 7, "inApp": true,
                            "vars": { "password": "hunter2" }, "context": [[41, "const secret = 'x'"]],
                        }]},
                    }]}},
                    { "type": "request", "data": { "headers": [["Cookie", "session=1"]] } },
                    { "type": "breadcrumbs", "data": { "values": [{ "message": "login jane@shop.example" }] } },
                ],
            }).to_string()),
        );
        responses.insert("https://gt.example.com/api/0/organizations/acme/".into(), (200, "{}".into()));
        Fake {
            cwd: PathBuf::from(REPO).join("src/checkout"),
            files,
            token: Ok(Some("gt-token-value".into())),
            responses,
            requests: RefCell::new(vec![]),
        }
    }

    fn args(reference: &str) -> Vec<String> {
        ["context", "--ref", reference, "--format", "json"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn helper_prints_sanitized_context_for_an_issue() {
        let env = fake();
        let (code, stdout, stderr) = run(&args("gt:web:1842"), &env);
        assert_eq!((code, stderr.as_str()), (0, ""));
        let value: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(value["state"], "error");
        assert_eq!(value["application"], json!({ "id": "web", "projectSlug": "shop-web" }));
        assert_eq!(value["issue"]["count"], 12);
        assert_eq!(value["issue"]["id"], "1842");
        assert_eq!(value["issue"]["title"], "TypeError: cannot read 'id' of undefined for [redacted]");
        assert_eq!(value["event"]["release"], "shop@2.4.1");
        assert_eq!(value["event"]["environment"], "production");
        let exception = &value["event"]["exceptions"][0];
        assert_eq!(exception["value"], "cannot read 'id' from [redacted] with [redacted]");
        assert_eq!(exception["frames"][0]["filename"], "src/checkout/pay.ts");
        assert_eq!(exception["frames"][0]["lineNo"], 42);
        for leaked in ["hunter2", "Cookie", "session=1", "jane@", "const secret", "gt-token-value", "evil.example"] {
            assert!(!stdout.contains(leaked), "{leaked} leaked");
        }
    }

    #[test]
    fn helper_uses_the_apps_glitchtip_address_never_the_repositorys() {
        let env = fake();
        run(&args("gt:shop-web:1842"), &env);
        assert!(env.requests.borrow().iter().all(|url| url.starts_with("https://gt.example.com/api/0/")));
    }

    #[test]
    fn helper_answers_a_test_reference_once_glitchtip_accepts_the_token() {
        let env = fake();
        let (code, stdout, _) = run(&args("gt:web:test"), &env);
        assert_eq!(code, 0);
        let value: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!((value["state"].as_str(), value["issue"].is_null()), (Some("test"), true));
        assert_eq!(*env.requests.borrow(), vec!["https://gt.example.com/api/0/organizations/acme/".to_string()]);
    }

    #[test]
    fn helper_exits_with_the_skills_codes() {
        let cases: Vec<(Vec<String>, Box<dyn Fn(&mut Fake)>, i32, &str)> = vec![
            (args("gt:web:1842"), Box::new(|env: &mut Fake| env.files.clear()), 2, "config-not-found"),
            (args("gt:api:1842"), Box::new(|_: &mut Fake| {}), 2, "reference-mismatch"),
            (args("1842"), Box::new(|_: &mut Fake| {}), 2, "reference-invalid"),
            (args("gt:web:18a2"), Box::new(|_: &mut Fake| {}), 2, "reference-invalid"),
            (
                vec!["context".into(), "--ref".into(), "gt:web:1".into(), "--format".into(), "text".into()],
                Box::new(|_: &mut Fake| {}),
                2,
                "format-unsupported",
            ),
            (
                args("gt:web:1842"),
                Box::new(|env: &mut Fake| {
                    let mut ws = workspace();
                    ws["workspace"]["glitchtip"]["baseUrl"] = json!("http://gt.example.com");
                    env.files.insert(PathBuf::from(HOME).join(APP_DATA_DIR).join(WORKSPACE_FILE), ws.to_string());
                }),
                2,
                "workspace-invalid",
            ),
            (
                args("gt:billing:1842"),
                Box::new(|env: &mut Fake| {
                    let config = json!({ "workspaceId": "ws-1", "applicationId": "billing" }).to_string();
                    env.files.insert(PathBuf::from(REPO).join(CONFIG_FILE), config);
                }),
                2,
                "repository-mismatch",
            ),
            (
                args("gt:web:1842"),
                Box::new(|env: &mut Fake| {
                    let mut ws = workspace();
                    ws["workspace"]["applications"][0]["repositoryPath"] = Value::Null;
                    env.files.insert(PathBuf::from(HOME).join(APP_DATA_DIR).join(WORKSPACE_FILE), ws.to_string());
                }),
                2,
                "repository-mismatch",
            ),
            (args("gt:web:1842"), Box::new(|env: &mut Fake| env.token = Ok(None)), 3, "credential-missing"),
            (args("gt:web:1842"), Box::new(|env: &mut Fake| env.token = Err(SecretError::Denied)), 3, "credential-denied"),
            (
                args("gt:web:1842"),
                Box::new(|env: &mut Fake| {
                    env.responses.insert("https://gt.example.com/api/0/issues/1842/".into(), (401, "{}".into()));
                }),
                3,
                "credential-rejected",
            ),
            (args("gt:web:1842"), Box::new(|env: &mut Fake| env.responses.clear()), 4, "issue-unreachable"),
            (
                args("gt:web:1842"),
                Box::new(|env: &mut Fake| {
                    env.responses.insert("https://gt.example.com/api/0/issues/1842/".into(), (502, "".into()));
                }),
                4,
                "issue-http-502",
            ),
            (
                args("gt:web:1842"),
                Box::new(|env: &mut Fake| {
                    let other = json!({ "id": "1842", "project": { "slug": "billing" } }).to_string();
                    env.responses.insert("https://gt.example.com/api/0/issues/1842/".into(), (200, other));
                }),
                2,
                "issue-not-in-project",
            ),
        ];
        for (arguments, setup, exit, step) in cases {
            let mut env = fake();
            setup(&mut env);
            let (code, stdout, stderr) = run(&arguments, &env);
            assert_eq!((code, stderr.trim()), (exit, format!("glitchtip-companion: {step}").as_str()), "{step}");
            assert!(stdout.is_empty());
        }
    }

    #[test]
    fn helper_stops_at_the_repository_root_when_looking_for_its_config() {
        let mut env = fake();
        env.files.remove(&PathBuf::from(REPO).join(CONFIG_FILE));
        env.files.insert(PathBuf::from("/Users/dev/code").join(CONFIG_FILE), "{}".into());
        let (code, _, stderr) = run(&args("gt:web:1842"), &env);
        assert_eq!((code, stderr.trim()), (2, "glitchtip-companion: config-not-found"));
    }

    #[test]
    fn helper_refuses_to_print_anything_that_still_reads_as_a_secret() {
        let mut env = fake();
        let issue = json!({ "id": "1842", "title": "leaked COMPANION_CANARY", "project": { "slug": "shop-web" } });
        env.responses.insert("https://gt.example.com/api/0/issues/1842/".into(), (200, issue.to_string()));
        let (code, stdout, stderr) = run(&args("gt:web:1842"), &env);
        assert_eq!((code, stdout.as_str(), stderr.trim()), (5, "", "glitchtip-companion: unsafe-context"));
    }

    #[test]
    fn redact_keeps_code_locations_and_drops_personal_data() {
        assert_eq!(redact("at pay (src/checkout/pay.ts:42:7)"), "at pay (src/checkout/pay.ts:42:7)");
        assert_eq!(redact("user jane@shop.example failed"), "user [redacted] failed");
        assert_eq!(redact("from 192.168.1.20:5432"), "from [redacted]");
        assert_eq!(redact("GET https://bob:pw@api.example/x"), "GET [redacted]");
        assert_eq!(redact("token 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc"), "token [redacted]");
        assert_eq!(redact("Authorization: Bearer abc"), "Authorization: [redacted]");
        assert_eq!(redact("release shop@2.4.1"), "release shop@2.4.1");
        assert_eq!(redact("TypeError: x is undefined"), "TypeError: x is undefined");
    }

    #[test]
    fn redact_drops_labelled_credentials_and_url_queries() {
        assert_eq!(redact("login failed password=shortsecret"), "login failed password=[redacted]");
        assert_eq!(redact("DB_PASSWORD: hunter2 rejected"), "DB_PASSWORD: [redacted] rejected");
        assert_eq!(redact(r#"body {"api_key": "abc123", "page": 2}"#), r#"body {"api_key": "[redacted]", "page": 2}"#);
        assert_eq!(redact("authorization: bearer shortsecret"), "authorization: [redacted]");
        assert_eq!(redact("X-Auth-Token: abc then"), "X-Auth-Token: [redacted] then");
        assert_eq!(redact("sent with bearer abc"), "sent with [redacted]");
        assert_eq!(
            redact("GET https://api.example/v1/pay?sig=abc&page=2 failed"),
            "GET https://api.example/v1/pay?[redacted] failed"
        );
        assert_eq!(redact("token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0ff"), "token: [redacted]");
        assert_eq!(redact(r#"password="correct horse battery staple" next"#), r#"password="[redacted]" next"#);
        assert_eq!(redact("secret='a b c"), "secret='[redacted]");
    }

    #[test]
    fn redact_reads_escaped_quotes_inside_a_quoted_credential() {
        assert_eq!(redact(r#"password="first\"second" next"#), r#"password="[redacted]" next"#);
        // A JSON body logged inside a JSON string keeps its quotes escaped.
        assert_eq!(
            redact(r#"body {\"api_key\": \"abc def\", \"page\": 2}"#),
            r#"body {\"api_key\": \"[redacted]\", \"page\": 2}"#
        );
        assert_eq!(
            redact(r#"body {\"password\": \"first\\\"second\"}"#),
            r#"body {\"password\": \"[redacted]\"}"#
        );
        assert_eq!(redact(r#"password="ends in \\" next"#), r#"password="[redacted]" next"#);
        assert_eq!(redact(r#"password="dangling \"#), r#"password="[redacted]"#);
    }

    #[test]
    fn redact_finishes_a_credential_another_rule_only_began() {
        assert_eq!(redact(r#"password="+12345678 hunter2" next"#), r#"password="[redacted]" next"#);
        assert_eq!(redact(r#"password="[redacted]hunter2""#), r#"password="[redacted]""#);
        assert_eq!(redact("password=[redacted]hunter2 next"), "password=[redacted] next");
        assert_eq!(redact("password=[redacted], next"), "password=[redacted], next");
        assert_eq!(redact("password=[redacted][redacted]hunter2 next"), "password=[redacted] next");
        assert_eq!(redact("password=[a]b] next"), "password=[redacted] next");
        assert_eq!(redact("[token=abc] next"), "[token=[redacted]] next");
        assert_eq!(redact("GET https://hunter2:token=abc@example.com/x"), "GET [redacted]");
        assert_eq!(redact("Authorization: Bearer  hunter2 next"), "Authorization: [redacted] next");
        assert_eq!(redact("sent with bearer   hunter2 next"), "sent with [redacted] next");
        assert_eq!(redact("password:\thunter2 next"), "password:\t[redacted] next");
        assert_eq!(redact("Authorization: Bearer\thunter2"), "Authorization: [redacted]");
        assert_eq!(redact("sent with bearer\thunter2 next"), "sent with [redacted] next");
    }

    #[test]
    fn redact_looks_inside_compact_json() {
        assert_eq!(
            redact(r#"bad payload {"email":"jane@example.com","ip":"192.168.1.20","phone":"212-555-0147"}"#),
            r#"bad payload {"email":"[redacted]","ip":"[redacted]","phone":"[redacted]"}"#
        );
        assert_eq!(redact(r#"{"url":"https://bob:pw@host/x","n":1}"#), r#"{"url":"[redacted]","n":1}"#);
        assert_eq!(redact(r#"{"at":"src/pay.ts:42:7"}"#), r#"{"at":"src/pay.ts:42:7"}"#);
        assert_eq!(redact(r#"body {\"email\":\"jane@example.com\"}"#), r#"body {\"email\":\"[redacted]\"}"#);
    }

    #[test]
    fn redact_reads_key_value_logs_and_paths() {
        assert_eq!(redact("ip=192.168.1.20 phone=212-555-0147 at=12:30:45"), "ip=[redacted] phone=[redacted] at=12:30:45");
        assert_eq!(redact("user:jane@example.com"), "[redacted]");
        assert_eq!(redact("GET /api/users/jane@example.com failed"), "GET [redacted] failed");
        assert_eq!(redact("GET https://bob:pa(ss)@example.com/x failed"), "GET [redacted] failed");
        assert_eq!(
            redact("Cannot find module '/app/node_modules/@scope/package/index.js'"),
            "Cannot find module '/app/node_modules/@scope/package/index.js'"
        );
        assert_eq!(redact("installed @scope/package@1.2.3 react@18.3.1"), "installed @scope/package@1.2.3 react@18.3.1");
        assert_eq!(redact("User jane@example.com: login failed!"), "User [redacted]: login failed!");
        assert_eq!(redact("GET http://192.168.1.20:8080/health?k=v failed"), "GET http://[redacted]/health?[redacted] failed");
    }

    #[test]
    fn redact_drops_every_cookie_in_a_cookie_header() {
        assert_eq!(
            redact("Cookie: sessionid=abc; connect.sid=s%3Asecret\nnext line"),
            "Cookie: [redacted]\nnext line"
        );
        assert_eq!(redact("set-cookie: a=1; Path=/; HttpOnly"), "set-cookie: [redacted]");
    }

    #[test]
    fn redact_reads_spaced_labels_mail_links_and_code_paths() {
        assert_eq!(redact("password : hunter2 next"), "password : [redacted] next");
        assert_eq!(redact("api_key = abc next"), "api_key = [redacted] next");
        assert_eq!(redact("open mailto:jane@example.com?subject=hello"), "open [redacted]");
        assert_eq!(redact("db/password: hunter2 next"), "db/password: [redacted] next");
        assert_eq!(redact("at src/auth.ts:42:7"), "at src/auth.ts:42:7");
    }

    #[test]
    fn redact_drops_phone_numbers_and_keeps_dates() {
        assert_eq!(redact("Customer called +1-212-555-0147"), "Customer called [redacted]");
        assert_eq!(redact("call +998 90 123 45 67 now"), "call [redacted] now");
        assert_eq!(redact("phone 212.555.0147 busy"), "phone [redacted] busy");
        assert_eq!(redact("due 2026-10-29 after +5 retries"), "due 2026-10-29 after +5 retries");
        assert_eq!(redact("order 12345 total 3.14159265358"), "order 12345 total 3.14159265358");
    }

    #[test]
    fn redact_survives_odd_input() {
        for input in [
            "\\", "\"", "password=", "password=\\", "password=\\\"", "token: '", "(", ") , ; :", "  212  555  ",
            "+", "+ 1", "٢١٢ ٥٥٥ ٠١٤٧", "пароль=секрет password=\"é\\\"ü\" (212) 555-0147)",
        ] {
            let _ = redact(input);
        }
        assert_eq!(redact("password=\\\"open"), "password=\\\"[redacted]");
    }

    #[test]
    fn redact_drops_local_numbers_written_in_groups_and_keeps_versions() {
        assert_eq!(redact("call 212 555 0147 now"), "call [redacted] now");
        assert_eq!(redact("call (212) 555-0147, then"), "call [redacted], then");
        assert_eq!(redact("tel 90 123 45 67"), "tel [redacted]");
        assert_eq!(redact("tel 8 912 345 67 89."), "tel [redacted].");
        assert_eq!(redact("build 1.20261029.123 failed"), "build 1.20261029.123 failed");
        assert_eq!(redact("at 2026-10-29 12:30:45 retry 1 2 3"), "at 2026-10-29 12:30:45 retry 1 2 3");
        assert_eq!(redact("macOS 10.15.7 and 3.14 2.71 1.41"), "macOS 10.15.7 and 3.14 2.71 1.41");
        assert_eq!(redact("call 212 555 0147 1"), "call [redacted] 1");
        assert_eq!(redact("delta +12.345678 m"), "delta +12.345678 m");
        assert_eq!(redact("call +1.212.555.0147"), "call [redacted]");
        assert_eq!(redact("call 555-0123 now"), "call [redacted] now");
        assert_eq!(redact("took 123.4567 ms, HTTP 200 1234"), "took 123.4567 ms, HTTP 200 1234");
        assert_eq!(redact("tel 0207946-09-58"), "tel [redacted]");
        assert_eq!(redact("at 2026-10-29 12 ok"), "at 2026-10-29 12 ok");
        assert_eq!(redact("ids 1001, 1002, 1003"), "ids 1001, 1002, 1003");
        // A version shaped exactly like a phone number goes too: a leaked number costs more.
        assert_eq!(redact("build 1.2026.1029"), "build [redacted]");
    }

    #[test]
    fn curl_reads_no_config_and_follows_no_redirect() {
        let command = curl("https://gt.example.com/api/0/");
        let args: Vec<&str> = command.get_args().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(command.get_program(), CURL);
        assert_eq!(args.first(), Some(&"--disable"));
        assert!(!args.iter().any(|a| a.starts_with("--location") || *a == "-L"));
        assert_eq!(&args[args.len() - 2..], ["--", "https://gt.example.com/api/0/"]);
    }

}
