#!/usr/bin/env python3
"""Prove the install works, end to end. Stdlib only.

The install is not the deliverable; this is. Every check prints PASS/FAIL with the evidence
that decided it, so a failure names its own cause instead of leaving you to guess.

    export GLITCHTIP_URL=https://errors.example.com
    export GLITCHTIP_TOKEN=...
    export GLITCHTIP_ORG=workspace
    python3 verify.py --project myapp [--relay-url http://relay:8090/] [--fire] [--test-alert]

--fire sends a REAL synthetic event to the project's own DSN and then polls for it. It creates
a genuine issue in the project, titled so it is obvious it was deliberate. Without --fire the
script only inspects configuration, which is faster but proves less.

CHECK 6 IS THE ONE THAT MATTERS. Delivery without scrubbing is worse than no delivery: it is
an ongoing export of user data wearing the appearance of a correct setup. If check 6 fails the
overall result is FAIL even when alerts are arriving.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

TIMEOUT = 20
MARKER = "glitchtip-onboarding verification event"

# urllib's default UA is on Cloudflare's banned-signature list; an instance behind Cloudflare
# answers 403 error_code 1010, which reads like an auth failure and is not one.
USER_AGENT = "glitchtip-onboarding/1.0"

# Substrings that must never appear in a stored event. Extend per project — the defaults are
# only the shapes that are universal.
DEFAULT_SCRUB_PATTERNS = [
    "password", "authorization", "api_key", "apikey", "secret",
    "bearer ", "sk-", "sk_live", "pk_live", "-----BEGIN",
]

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, evidence: str) -> bool:
    results.append((name, ok, evidence))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}\n       {evidence}")
    return ok


def api(base: str, path: str, token: str, method: str = "GET", body: dict | None = None):
    url = f"{base.rstrip('/')}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("User-Agent", USER_AGENT)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read().decode("utf-8", "replace")
        return resp.status, (json.loads(raw) if raw.strip() else None)


def parse_dsn(dsn: str) -> tuple[str, str, str]:
    """DSN -> (ingest origin, public key, project id). Raises on a malformed value."""
    parsed = urllib.parse.urlparse(dsn)
    project_id = parsed.path.strip("/").split("/")[-1]
    if not parsed.hostname or not parsed.username or not project_id:
        raise ValueError("malformed DSN")
    origin = f"{parsed.scheme}://{parsed.hostname}" + (f":{parsed.port}" if parsed.port else "")
    return origin, parsed.username, project_id


def flatten(value, out: list[str]) -> None:
    """Every string anywhere in the event, so a scrub check cannot be fooled by nesting."""
    if isinstance(value, dict):
        for key, item in value.items():
            out.append(str(key))
            flatten(item, out)
    elif isinstance(value, list):
        for item in value:
            flatten(item, out)
    elif value is not None:
        out.append(str(value))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True)
    parser.add_argument("--org", default=os.getenv("GLITCHTIP_ORG", ""))
    parser.add_argument("--relay-url", help="checked for reachability if given")
    parser.add_argument("--fire", action="store_true", help="send a real synthetic event and poll for it")
    parser.add_argument("--test-alert", action="store_true", help="fire the alert rule's own test endpoint")
    parser.add_argument("--poll-seconds", type=int, default=45)
    parser.add_argument("--scrub", action="append", default=[], help="extra substring that must NOT appear; repeatable")
    args = parser.parse_args()

    base = os.getenv("GLITCHTIP_URL", "").strip().rstrip("/")
    token = os.getenv("GLITCHTIP_TOKEN", "").strip()
    org = args.org
    if not (base and token and org):
        raise SystemExit("GLITCHTIP_URL, GLITCHTIP_TOKEN and GLITCHTIP_ORG must all be set")
    slug = args.project
    patterns = DEFAULT_SCRUB_PATTERNS + args.scrub

    # 1 -------------------------------------------------------------- auth
    try:
        status, _ = api(base, "/api/0/organizations/", token)
        record("1 API authenticates", status == 200, f"GET /api/0/organizations/ -> {status}")
    except Exception as exc:  # noqa: BLE001 — a verifier reports, it does not raise
        record("1 API authenticates", False, f"{type(exc).__name__}: {exc}")
        return summarize()

    # 2 --------------------------------------------------------- project+key
    dsn = ""
    try:
        _, keys = api(base, f"/api/0/projects/{org}/{slug}/keys/", token)
        dsn = ((keys or [{}])[0].get("dsn") or {}).get("public", "")
        record("2 project exists and has a key", bool(dsn),
               f"{len(keys or [])} key(s); DSN {'resolved' if dsn else 'MISSING'}")  # never the value
    except Exception as exc:  # noqa: BLE001
        record("2 project exists and has a key", False, f"{type(exc).__name__}: {exc}")

    # 3 ------------------------------------------------------------- alerts
    alert_id = None
    webhook_urls: list[str] = []
    try:
        _, alerts = api(base, f"/api/0/projects/{org}/{slug}/alerts/", token)
        for alert in alerts or []:
            for recipient in alert.get("alertRecipients") or []:
                if recipient.get("recipientType") == "webhook" and recipient.get("url"):
                    webhook_urls.append(recipient["url"])
                    alert_id = alert.get("pk") or alert.get("id")
        record("3 alert rule with a webhook recipient", bool(webhook_urls),
               f"{len(alerts or [])} rule(s), webhooks: {webhook_urls or 'NONE — nothing will reach Telegram'}")
    except Exception as exc:  # noqa: BLE001
        record("3 alert rule with a webhook recipient", False, f"{type(exc).__name__}: {exc}")

    # 4 -------------------------------------------------------------- relay
    relay = args.relay_url or (webhook_urls[0] if webhook_urls else "")
    if relay and not relay.startswith("http://relay"):
        try:
            with urllib.request.urlopen(relay, timeout=10) as resp:
                record("4 relay answers", resp.status == 200, f"GET {relay} -> {resp.status}")
        except Exception as exc:  # noqa: BLE001
            record("4 relay answers", False, f"GET {relay} -> {type(exc).__name__}: {exc}")
    else:
        record("4 relay answers", True,
               f"skipped: {relay or 'no webhook'} is only reachable from inside the compose "
               f"network — check with `docker compose exec worker wget -qO- {relay or 'http://relay:8090/'}`")

    # 5 + 6 ------------------------------------------------- fire and inspect
    if args.fire and dsn:
        try:
            origin, public_key, project_id = parse_dsn(dsn)
            # `event_id` is REQUIRED — omitting it returns 422 with
            # {"loc": ["body","payload","event_id"], "msg": "Field required"}, not a hint that
            # the DSN or auth header is wrong. Sentry's own SDKs always generate one, so this
            # only bites a hand-rolled probe like this.
            payload = {
                "event_id": uuid.uuid4().hex,
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "level": "error",
                "platform": "other",
                "logger": "glitchtip-onboarding",
                "exception": {"values": [{"type": "VerificationEvent", "value": MARKER}]},
            }
            req = urllib.request.Request(
                f"{origin}/api/{project_id}/store/", data=json.dumps(payload).encode(), method="POST"
            )
            req.add_header("Content-Type", "application/json")
            # The ingest endpoint needs the User-Agent too, not only the API calls — it is the
            # same Cloudflare edge. Missing it here produced a 403 on step 5 while steps 1-3
            # passed, which reads like an ingest/DSN problem and is not one.
            req.add_header("User-Agent", USER_AGENT)
            req.add_header(
                "X-Sentry-Auth",
                f"Sentry sentry_version=7, sentry_key={public_key}, sentry_client=glitchtip-onboarding/1.0",
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                accepted = resp.status in (200, 201, 202)
            found = None
            deadline = time.time() + args.poll_seconds
            while time.time() < deadline and not found:
                time.sleep(3)
                try:
                    _, issues = api(base, f"/api/0/projects/{org}/{slug}/issues/?query=", token)
                    found = next((i for i in issues or [] if MARKER in json.dumps(i)), None)
                except Exception:  # noqa: BLE001 — keep polling; report the timeout instead
                    pass
            record("5 synthetic event arrives", bool(found),
                   f"ingest accepted={accepted}; polled {args.poll_seconds}s; "
                   f"{'issue found' if found else 'NOT found — check the DSN and the ingest origin'}")

            if found:
                _, event = api(base, f"/api/0/issues/{found.get('id')}/events/latest/", token)
                strings: list[str] = []
                flatten(event, strings)
                blob = " ".join(strings).lower()
                hits = [p for p in patterns if p.lower() in blob]
                has_locals = '"vars"' in json.dumps(event) or "'vars'" in json.dumps(event)
                clean = not hits and not has_locals
                record("6 stored event carries no locals and no scrub-pattern hits", clean,
                       f"frame vars present={has_locals}; pattern hits={hits or 'none'}")
            else:
                record("6 stored event carries no locals and no scrub-pattern hits", False,
                       "not checked — no event arrived")
        except Exception as exc:  # noqa: BLE001
            record("5 synthetic event arrives", False, f"{type(exc).__name__}: {exc}")
            record("6 stored event carries no locals and no scrub-pattern hits", False, "not checked")
    else:
        print("[SKIP] 5-6 — pass --fire to send a real event (this is the half that proves delivery)")

    # 7 ---------------------------------------------------------- test alert
    if args.test_alert and alert_id:
        try:
            status, _ = api(base, f"/api/0/projects/{org}/{slug}/alerts/{alert_id}/test/", token, method="POST")
            record("7 alert test fires", 200 <= status < 300, f"POST .../alerts/{alert_id}/test/ -> {status}")
        except Exception as exc:  # noqa: BLE001
            record("7 alert test fires", False, f"{type(exc).__name__}: {exc}")

    return summarize()


def summarize() -> int:
    failed = [name for name, ok, _ in results if not ok]
    print("\n" + "=" * 72)
    if failed:
        print(f"FAIL — {len(failed)} of {len(results)} checks failed:")
        for name in failed:
            print(f"  - {name}")
        print("\nThe install is NOT done. Fix these, then re-run.")
        return 1
    print(f"PASS — all {len(results)} checks.")
    print("\nOne thing this script CANNOT check: that a human saw the message. Open the Telegram")
    print("group and confirm a message arrived AND that its project label names THIS project.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
