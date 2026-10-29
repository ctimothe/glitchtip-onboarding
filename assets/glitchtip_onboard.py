#!/usr/bin/env python3
"""Converge a GlitchTip instance to a desired project state. Idempotent, stdlib only.

Re-running is safe and is the intended way to use it: the project SLUG is the identity key,
and every sub-resource (key, alert rule) is matched by a stable name before it is created. A
fully-configured instance exits 0 reporting "already configured" — so this is safe in CI and
safe to run when you are not sure what state the instance is in. That uncertainty is the
normal case; a partial install is what you usually inherit.

    export GLITCHTIP_URL=https://errors.example.com
    export GLITCHTIP_TOKEN=...          # never an argument: argv lands in `ps` and in history
    export GLITCHTIP_ORG=workspace

    python3 glitchtip_onboard.py --project myapp --platform python-fastapi \
        --webhook-url http://relay:8090/ --write-env ./.env --dry-run

What it will NOT do, by design:
  * print the DSN anywhere — stdout, stderr, an exception, or the JSON summary. It is written
    to the env file and referred to afterwards only by its key name. There is no --print-dsn.
  * write a secret into a file git can see. Before writing it requires `git check-ignore` to
    succeed AND `git ls-files --error-unmatch` to fail, and refuses any path ending .example.
  * DELETE or PUT anything. It creates what is missing. It cannot rotate a key, rename a
    project, or remove an alert — those are decisions for a human with the UI open.
  * accept the token on the command line.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

TIMEOUT = 20

# urllib's default User-Agent ("Python-urllib/3.x") is on Cloudflare's banned-signature list.
# An instance behind Cloudflare answers HTTP 403 error_code 1010 "browser_signature_banned" —
# which reads like an auth failure and is not one. Send a real UA on every request.
USER_AGENT = "glitchtip-onboarding/1.0 (+https://github.com/Lex-Analytics-Group)"


class ApiError(RuntimeError):
    pass


# ---------------------------------------------------------------- transport


def _request(method: str, base: str, path: str, token: str, body: dict | None = None) -> object:
    """One HTTP call. Raises ApiError with the response body, never with the token in it."""
    url = f"{base.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", USER_AGENT)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        # The Authorization header is never echoed here — only method, URL, status, body.
        raise ApiError(f"{method} {path} -> HTTP {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise ApiError(f"{method} {path} -> unreachable: {exc.reason}") from None


# ---------------------------------------------------------------- helpers


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip().lower()).strip("-")
    if not slug:
        raise SystemExit("refusing: --project produced an empty slug")
    return slug


def _git_ok(args: list[str], cwd: str) -> bool:
    try:
        return subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, timeout=10
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def assert_safe_env_path(path: str, *, dry_run: bool) -> None:
    """Refuse to write a DSN anywhere git could pick it up.

    A DSN is a write credential for your error stream. Committing one lets anyone forge
    events into your project, which is both a noise and a trust problem.
    """
    if path.endswith(".example"):
        raise SystemExit(f"refusing: {path} is a template — a DSN must never go in one")
    directory = os.path.dirname(os.path.abspath(path)) or "."
    if not _git_ok(["rev-parse", "--is-inside-work-tree"], directory):
        if dry_run:
            return
        raise SystemExit(
            f"refusing: {directory} is not a git worktree, so ignore status cannot be proven"
        )
    if not _git_ok(["check-ignore", "-q", path], directory):
        raise SystemExit(f"refusing: {path} is NOT gitignored — add it to .gitignore first")
    if _git_ok(["ls-files", "--error-unmatch", path], directory):
        raise SystemExit(f"refusing: {path} is TRACKED by git")


def upsert_env(path: str, key: str, value: str) -> str:
    """Set key=value in an env file, preserving everything else. Returns 'created'|'updated'|'unchanged'."""
    lines: list[str] = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*=")
    for index, line in enumerate(lines):
        if pattern.match(line):
            if line.split("=", 1)[1].strip() == value:
                return "unchanged"
            lines[index] = f"{key}={value}"
            break
    else:
        lines.append(f"{key}={value}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.chmod(path, 0o600)
    return "updated"


# ---------------------------------------------------------------- phases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="human name, e.g. 'My App'")
    parser.add_argument("--slug", help="defaults to a slugified --project")
    parser.add_argument("--org", default=os.getenv("GLITCHTIP_ORG", ""))
    parser.add_argument("--team", help="defaults to the org slug")
    parser.add_argument("--create-team", action="store_true")
    parser.add_argument("--platform", default="other", help="e.g. python-fastapi, javascript-react, node")
    parser.add_argument("--webhook-url", help="relay URL; creates the alert rule when given")
    parser.add_argument("--alert-quantity", type=int, default=1)
    parser.add_argument("--alert-timespan-minutes", type=int, default=10)
    parser.add_argument("--test-alert", action="store_true", help="fire the rule's test endpoint")
    parser.add_argument("--write-env", help="env file to receive the DSN (must be gitignored)")
    parser.add_argument("--env-key", default="GLITCHTIP_DSN")
    parser.add_argument("--json-summary", help="write a NON-SECRET summary here")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-insecure", action="store_true", help="permit a non-HTTPS instance (localhost only)")
    args = parser.parse_args()

    base = os.getenv("GLITCHTIP_URL", "").strip().rstrip("/")
    token = os.getenv("GLITCHTIP_TOKEN", "").strip()
    if not base:
        raise SystemExit("GLITCHTIP_URL is not set")
    if not token:
        raise SystemExit(
            "GLITCHTIP_TOKEN is not set. The first token cannot be minted through the API "
            "(POST /api/0/api-tokens/ accepts session auth only) — create it in the UI under "
            "Profile -> Auth Tokens."
        )
    if not base.startswith("https://") and not args.allow_insecure:
        raise SystemExit(f"refusing a non-HTTPS instance ({base}) without --allow-insecure")
    if not args.org:
        raise SystemExit("--org or GLITCHTIP_ORG is required")
    if args.webhook_url and not args.webhook_url.startswith(("https://", "http://relay", "http://localhost", "http://127.")):
        raise SystemExit(
            "refusing a non-HTTPS --webhook-url: the relay payload carries issue titles. "
            "An internal docker hostname (http://relay:8090/) is accepted."
        )

    slug = args.slug or slugify(args.project)
    team = args.team or args.org
    created: list[str] = []
    skipped: list[str] = []

    def api(method: str, path: str, body: dict | None = None) -> object:
        if args.dry_run and method != "GET":
            print(f"  would: {method} {path}")
            return {}
        return _request(method, base, path, token, body)

    if args.write_env:
        assert_safe_env_path(args.write_env, dry_run=args.dry_run)

    # 1. Auth smoke test FIRST, so a bad token fails here with a clear message rather than as
    #    a confusing 404 three calls later.
    _request("GET", base, "/api/0/organizations/", token)
    print(f"auth ok -> {base}")

    # 2. Org must exist. We never create one implicitly: an org is a billing/ownership
    #    boundary and inventing one silently is how you end up with two.
    _request("GET", base, f"/api/0/organizations/{args.org}/", token)
    print(f"org ok -> {args.org}")

    # 3. Team. A project must belong to one.
    teams = _request("GET", base, f"/api/0/organizations/{args.org}/teams/", token) or []
    if not any(t.get("slug") == team for t in teams):
        if not args.create_team:
            raise SystemExit(
                f"team '{team}' does not exist in org '{args.org}'. "
                f"Existing: {[t.get('slug') for t in teams]}. Re-run with --create-team to create it."
            )
        api("POST", f"/api/0/organizations/{args.org}/teams/", {"slug": team})
        created.append(f"team:{team}")
        print(f"team created -> {team}")
    else:
        skipped.append(f"team:{team}")
        print(f"team ok -> {team}")

    # 4. THE IDEMPOTENCY GATE. List before creating, always.
    projects = _request("GET", base, f"/api/0/organizations/{args.org}/projects/", token) or []
    exists = any(p.get("slug") == slug for p in projects)
    if exists:
        skipped.append(f"project:{slug}")
        print(f"project ok -> {slug} (already exists)")
    else:
        # NOTE: creation lives on the TEAM endpoint. The organization projects endpoint is
        # GET-only and POSTing to it returns 405 — which reads like an auth problem and is not.
        api(
            "POST",
            f"/api/0/teams/{args.org}/{team}/projects/",
            {"name": args.project, "slug": slug, "platform": args.platform},
        )
        created.append(f"project:{slug}")
        print(f"project created -> {slug}")

    # 5. DSN. Read it back; create a key only if the project genuinely has none.
    dsn = ""
    if not (args.dry_run and not exists):
        keys = _request("GET", base, f"/api/0/projects/{args.org}/{slug}/keys/", token) or []
        if not keys:
            api("POST", f"/api/0/projects/{args.org}/{slug}/keys/", {"name": "default"})
            created.append("key:default")
            keys = _request("GET", base, f"/api/0/projects/{args.org}/{slug}/keys/", token) or []
        if keys:
            dsn = (keys[0].get("dsn") or {}).get("public", "")
    print(f"dsn      -> {'resolved' if dsn else 'NOT resolved'}")  # never the value

    # 6. Alert rule -> relay. Matched by name so a re-run does not stack duplicates.
    alert_id = None
    if args.webhook_url:
        rule_name = "All new issues to Telegram"
        alerts = _request("GET", base, f"/api/0/projects/{args.org}/{slug}/alerts/", token) or []
        match = next((a for a in alerts if a.get("name") == rule_name), None)
        if match:
            alert_id = match.get("pk") or match.get("id")
            skipped.append(f"alert:{rule_name}")
            print(f"alert ok -> {rule_name}")
        else:
            body = {
                "name": rule_name,
                "timespanMinutes": args.alert_timespan_minutes,
                "quantity": args.alert_quantity,
                "alertRecipients": [{"recipientType": "webhook", "url": args.webhook_url}],
            }
            result = api("POST", f"/api/0/projects/{args.org}/{slug}/alerts/", body)
            alert_id = (result or {}).get("pk") or (result or {}).get("id")
            created.append(f"alert:{rule_name}")
            print(f"alert created -> {rule_name}")

    if args.test_alert and alert_id:
        api("POST", f"/api/0/projects/{args.org}/{slug}/alerts/{alert_id}/test/")
        print("test alert fired (check Telegram)")

    # 7. Persist the DSN, and only into a file git cannot see.
    if args.write_env and dsn and not args.dry_run:
        state = upsert_env(args.write_env, args.env_key, dsn)
        print(f"env      -> {args.env_key} {state} in {args.write_env} (mode 0600)")
    elif args.write_env:
        print(f"env      -> would write {args.env_key} to {args.write_env}")

    summary = {
        "org": args.org,
        "team": team,
        "project_slug": slug,
        "platform": args.platform,
        "alert_id": alert_id,
        "dsn_written_to": args.write_env if (args.write_env and dsn) else None,
        "dsn_env_key": args.env_key,
        "created": created,
        "skipped": skipped,
        "dry_run": args.dry_run,
    }
    if args.json_summary and not args.dry_run:
        with open(args.json_summary, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))

    if not created:
        print("\nalready configured — nothing to do")
    else:
        print(f"\ncreated: {', '.join(created)}")
        print("NEXT: wire the SDK (SKILL.md phases 2-4), then run verify.py — this script only "
              "provisioned the server side. Nothing is reporting yet.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
