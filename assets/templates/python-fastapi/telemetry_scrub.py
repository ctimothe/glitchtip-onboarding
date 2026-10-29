"""Scrub user data out of error events before they leave the process.

A leaf module: stdlib only, imports nothing from the app, so it cannot join an import cycle
and can be unit-tested with plain dicts. Copy it into the project as `src/telemetry_scrub.py`
and adapt only `DENY_KEY_SUBSTRINGS` / `DENY_VALUE_PATTERNS` to what this product must not
emit.

WHY THIS EXISTS, precisely. `send_default_pii=False` gates cookies, the request body and the
user block. It does NOT gate `include_local_variables`, which defaults to **True** — so every
local in every frame of the traceback is serialized. The function argument holding a document,
a prompt, a customer record or a user id travels with the error, to a server, where it is
stored and searchable. Turning frame locals off is the single most effective line here; this
module is the second layer, for everything that arrives by another route.

Breadcrumbs are the leak people forget. A logging integration promotes
`logger.exception("... user_id=%s ...")` into a breadcrumb, and breadcrumbs are NOT filtered by
`before_send` — they need `before_breadcrumb`. Wire both.

Design contract, matching the alerting module's:
  * never raises — a scrubber that throws inside the SDK loses the event AND the error
  * fail CLOSED — if scrubbing a field fails, drop the field rather than pass it through
"""
from __future__ import annotations

import re
from typing import Any

REDACTED = "[redacted]"

# Any dict key CONTAINING one of these (case-insensitive) has its value replaced.
DENY_KEY_SUBSTRINGS = (
    "password", "passwd", "secret", "token", "api_key", "apikey", "authorization",
    "auth", "cookie", "session", "credential", "private_key", "access_key",
    # --- product-specific: extend for the app being onboarded ---
    # "message", "document_text", "query", "prompt", "answer",
)

# Values matching these are replaced wherever they appear, whatever the key.
DENY_VALUE_PATTERNS = (
    re.compile(r"\bBearer\s+[A-Za-z0-9._\-]+", re.I),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),           # OpenAI / OpenRouter style
    re.compile(r"\b(sk|pk)_(live|test)_[A-Za-z0-9]{8,}"),  # Stripe / Clerk style
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),  # email
    re.compile(r"(?<![\d.])\+?\d[\d\s().-]{8,}\d(?![\d.])"),            # phone-ish
)

# How deep to walk before giving up. An event is a tree; a cycle or a pathological depth must
# not turn scrubbing into a hang inside the SDK's send path.
_MAX_DEPTH = 12


def _scrub_text(value: str) -> str:
    for pattern in DENY_VALUE_PATTERNS:
        value = pattern.sub(REDACTED, value)
    return value


def _scrub(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        return REDACTED
    if isinstance(value, str):
        return _scrub_text(value)
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if any(bad in lowered for bad in DENY_KEY_SUBSTRINGS):
                out[key] = REDACTED
            else:
                out[key] = _scrub(item, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [_scrub(item, depth + 1) for item in value]
    return value


def scrub_event(event: dict, _hint: dict | None = None) -> dict | None:
    """`before_send`. Returns the event, or None to drop it entirely."""
    try:
        # Belt and braces: even with include_local_variables=False, strip any `vars` an
        # integration attached itself. This is the field that carries function arguments.
        for frame_container in (event.get("exception"), event.get("threads")):
            for entry in (frame_container or {}).get("values", []) or []:
                for frame in (entry.get("stacktrace") or {}).get("frames", []) or []:
                    frame.pop("vars", None)
        return _scrub(event)
    except Exception:  # noqa: BLE001
        # Fail CLOSED. An event we could not scrub is an event we must not send.
        return None


def scrub_breadcrumb(crumb: dict, _hint: dict | None = None) -> dict | None:
    """`before_breadcrumb`. Breadcrumbs bypass before_send — this is not optional."""
    try:
        return _scrub(crumb)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------------------
# Wiring, for reference. Put this in the app entry point, after env loading and BEFORE the
# app module is imported.
#
#     import sentry_sdk
#     from .telemetry_scrub import scrub_breadcrumb, scrub_event
#
#     dsn = (os.getenv("GLITCHTIP_DSN") or os.getenv("SENTRY_DSN") or "").strip()
#     if dsn:
#         try:
#             sentry_sdk.init(
#                 dsn=dsn,
#                 environment=os.getenv("ENV", "production"),
#                 release=(os.getenv("GIT_SHA") or "").strip() or None,
#                 traces_sample_rate=0.0,
#                 send_default_pii=False,
#                 include_local_variables=False,   # THE important one
#                 max_request_body_size="never",
#                 before_send=scrub_event,
#                 before_breadcrumb=scrub_breadcrumb,
#             )
#         except Exception:
#             logger.warning("error tracking init failed; continuing without it", exc_info=True)
#
# Then TEST it with the app's real shapes, not with the string "secret":
#
#     def test_a_document_argument_never_reaches_the_wire():
#         event = {"exception": {"values": [{"stacktrace": {"frames": [
#             {"function": "run", "vars": {"text": "<a real decision excerpt>"}}]}}]}}
#         assert "decision" not in json.dumps(scrub_event(event))
# ---------------------------------------------------------------------------------------
