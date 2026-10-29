---
name: glitchtip-onboarding
description: Install end-to-end GlitchTip observability into an application — reusable JavaScript/TypeScript SDK adapters or native-language SDK wiring, privacy scrubbing, alert rules, Telegram routing, and live verification. Use when a project needs error, warning, or info reporting; has a dashboard nobody reads; has alerts that do not reach Telegram; or is being connected to GlitchTip or Sentry-compatible ingest.
---

# Onboard a project to GlitchTip

The goal is not "the SDK is installed". The goal is: **a real error, in production, reaches a
human in Telegram, with enough context to fix it, and without carrying user data out of the
box.** An install that stops short of that has produced a dashboard, and nobody looks at a
dashboard at 2am.

Work through the phases in order. Each phase ends in a **checked fact**, not an assumption.
Never report a phase done on the strength of "the code looks right".

---

## Phase 0 — Establish the ground truth (never skip)

Do these before writing a single line. Most failed installs are a wrong assumption made in the
first two minutes.

1. **Find the instance.** `GLITCHTIP_URL` / `GLITCHTIP_INGEST_ORIGIN` / `SENTRY_DSN` in any
   env file, or a `glitchtip` directory on the ops host. Fetch `{base}/api/0/openapi.json` and
   confirm it returns 200 with `"title": "GlitchTip API"`. If it does not, you have the wrong
   base URL — stop and resolve that before anything else.
2. **Confirm it is GlitchTip, not Sentry.io.** They share an ingest protocol and diverge on
   features. Session replay, Release Health sessions and several tracing surfaces do not exist
   in GlitchTip and silently discard the traffic you send them.
3. **Inventory what already exists.** Run `assets/glitchtip_onboard.py --dry-run`. It reports
   the org, the team, whether the project exists, whether a key exists, and whether an alert
   rule already points at the relay. **A partial install is the normal starting state.** Never
   assume greenfield.
4. **Identify every process that can throw.** Not just the web server. Enumerate: HTTP API,
   background workers, cron jobs, CLI entry points, the browser bundle, and any streaming
   endpoint. Each is a separate wiring decision, and streaming endpoints are the one people
   miss (see the trap in `references/edge-cases.md`).
   If `package.json` exists, identify supported frameworks from dependencies and file layout:
   Next.js, NestJS, Fastify, Express, and React. A project can need both a server adapter and
   the React adapter.
5. **Find the existing alert path, if any.** Many projects already post to Telegram directly
   from application code. That is a *different* channel from GlitchTip and both should exist —
   see "Two channels, on purpose" below. Do not delete one to install the other.

**When to stop and ask the user.** Use the `grilling` skill (or ask plainly) if any of these
are true, because guessing wrong here is expensive and silent:

- More than one GlitchTip instance or org is reachable and it is not obvious which is correct.
- The project handles regulated or personal data (health, legal, financial, biometric) and no
  scrubbing policy is written down anywhere. **Ask what must never leave the box.** Do not
  invent the policy.
- A Telegram chat id is not discoverable and there is more than one plausible group.
- The app is multi-tenant and it is unclear whether one GlitchTip project or one per tenant is
  wanted.
- Production and staging share a DSN. That is almost always a mistake, but it is occasionally
  deliberate; confirm rather than "fix" it.

Everything else you can decide yourself from the defaults in this document.

---

## Phase 1 — Provision the project (idempotent, API-driven)

```bash
export GLITCHTIP_URL=https://errors.example.com
export GLITCHTIP_TOKEN=...        # never pass as an argument; argv lands in ps and history
export GLITCHTIP_ORG=workspace

python3 assets/glitchtip_onboard.py \
  --project "myapp" \
  --platform python-fastapi \
  --webhook-url http://relay:8090/ \
  --write-env ./.env \
  --dry-run                        # ALWAYS dry-run first, then re-run without it
```

The script converges an instance to a desired state. Re-running is safe: the project slug is
the identity key and every sub-resource is matched by name before creation, so a second run
reports `already configured` and exits 0.

**The one API trap:** projects are created on the **team** endpoint,
`POST /api/0/teams/{org}/{team}/projects/`. The organization projects endpoint is **GET-only**.
An agent that reads the org URL from the list response and POSTs to it gets a 405 and usually
concludes the token is wrong. It is not.

The bootstrap token itself cannot be minted through the API — `POST /api/0/api-tokens/` accepts
only session auth. Minting the first token in the UI is the one irreducibly manual step; say so
plainly rather than looping on 401s.

---

## Phase 2 — Decide the scrubbing policy BEFORE wiring any SDK

This phase comes before the SDK on purpose. Wiring first and scrubbing later means every error
between the two ships unscrubbed, and those events are not retractable.

**`send_default_pii=False` is not the control most people think it is.** It gates cookies, the
request body and the user block. It does **not** gate `include_local_variables`, which defaults
to **True** in the Python SDK. Every local variable in every frame of the traceback is
serialized — which means the function argument holding a document, a prompt, a user id or a
customer record travels with the error.

Set all three, always:

| Setting | Value | What it stops |
|---|---|---|
| `send_default_pii` | `False` | cookies, request body, user block |
| `include_local_variables` | `False` | frame locals — the big one |
| `max_request_body_size` | `"never"` | explicit rather than inherited |

Then add a `before_send` **and** a `before_breadcrumb`. Breadcrumbs are the leak everyone
forgets: a logging integration promotes `logger.exception("... user_id=%s ...")` into a
breadcrumb, and breadcrumbs bypass `before_send` filtering of the exception itself.

Put the scrubber in its own **leaf module** with no infrastructure imports, so it is unit
testable with plain strings and cannot participate in an import cycle. Template:
`assets/templates/python-fastapi/telemetry_scrub.py`.

Test it with the actual shapes the app produces, not with `"secret"`. Take a real function
signature from the codebase and assert its argument does not appear in the serialized event.

For supported JavaScript and TypeScript projects, `@glitchtip-onboarding/sdk` owns these
defaults. Still inspect the application for telemetry added outside the package and test the
real context values it passes through `extra`, tags, and user identity.

---

## Phase 3 — Wire the backend

Rules that apply to every language:

1. **Init as early as possible**, after env loading and before the app module is imported, so
   capture is armed before the first request is served.
2. **Env-gated.** No DSN means a silent no-op, never a crash and never a warning storm. Dev and
   CI must stay quiet.
3. **It never throws.** Wrap init in try/except and swallow. Observability that can take the
   app down is worse than no observability.
4. **Tag `environment` explicitly.** Never rely on `NODE_ENV`/`MODE` alone — a staging build
   made in production mode is otherwise indistinguishable from production.
5. **Tag `release` with the deployed commit**, and make sure the value actually reaches the
   **process**. Writing a `DEPLOYED_VERSION.txt` that nothing reads at runtime is the most
   common way this silently stays `None`. Verify with the process's own environment, not with
   the file.
6. **`traces_sample_rate=0.0`.** Errors only. Nobody is reading transaction volume, and
   GlitchTip's tracing surface is not where the value is.

For JavaScript and TypeScript, use the project's existing package manager to install
`@glitchtip-onboarding/sdk`, then follow the matching guide:

| Detected runtime or framework | Entry point | Guide |
|---|---|---|
| Node.js process, worker, cron, CLI | `@glitchtip-onboarding/sdk/node` | `docs/sdk/getting-started.md` |
| Express | `@glitchtip-onboarding/sdk/express` | `docs/sdk/express.md` |
| NestJS | `@glitchtip-onboarding/sdk/nest` | `docs/sdk/nest.md` |
| Fastify | `@glitchtip-onboarding/sdk/fastify` | `docs/sdk/fastify.md` |
| Next.js server or route | `@glitchtip-onboarding/sdk/next` | `docs/sdk/next.md` |

Create one reporter per runtime, after environment loading. Install the framework adapter,
then run the application's existing type check, tests, and production build. The package is
not a substitute for framework wiring; an installed dependency with no adapter registered
captures nothing.

For Python FastAPI, continue using `assets/templates/python-fastapi/telemetry_scrub.py` and
the native Python SDK settings above.

### Streaming endpoints — the trap that makes this whole install pointless

If a route returns a stream (SSE, chunked, WebSocket), an exception inside the generator
**does not reach the framework's error handler**, because the response headers were already
sent. The handler you just wired will never fire for the single most important path in most
products.

Find every streaming handler. In each `except` block, capture explicitly. Pass the exception
**type** and a request id — never the payload.

---

## Phase 4 — Wire the browser

The browser is where real users' errors happen, and it is the half most installs skip.

**Defer the SDK. That is the whole bundle story.** Measured on a real Vite + React 18 build
with @sentry/react 10.70.0, by building both ways:

| | entry chunk (gzip) |
|---|---|
| no telemetry | 108.07 kB |
| telemetry, dynamically imported | 108.09 kB — **+0.02 kB** |
| the SDK itself | a **30.54 kB** async chunk, fetched after first paint |

**A claim you may meet elsewhere, and which was tested here and refuted:** that named imports
beat `import * as Sentry`. Swapping all 11 symbols to a namespace import produced a
**byte-identical** chunk — same content hash. Rollup tree-shakes both the same way. Do not
repeat the "+30 kB vs +0.5 kB" figure; it did not reproduce.

The reusable browser reporter owns the explicit integration list. Replay, feedback, tracing
and profiling are never constructed, so they never record anything — and GlitchTip has no
ingest for them regardless. Do not initialize a second Sentry client beside the package.

For React, follow `docs/sdk/react.md`: install a stable reporter proxy in the provider and load
`@glitchtip-onboarding/sdk/browser` with a guarded dynamic import. This keeps the telemetry
SDK out of the entry chunk without remounting the application when initialization completes.

Also, in the browser specifically:

- **Filter benign noise** — `ResizeObserver loop`, bare `Script error.`, `AbortError`,
  extension URLs. Without this the alert feed fills with things that are not bugs and the team
  stops reading it. That is the failure mode: not too few alerts, too many.
- **Attach a non-PII identity.** Send an opaque user id and a role. Never a name, phone or
  email — resolve those out of band at alert time if they are needed at all.
- **Consider a same-origin tunnel.** Ad blockers and privacy extensions block direct requests
  to error-reporting hosts, so a share of real users' errors never arrive. Routing the envelope
  through your own origin fixes that and sidesteps CORS. If you build one, it **must** verify
  the envelope's DSN key is yours — otherwise you have an open relay that anyone can use to
  spam your instance. See `references/architecture.md`.

React and generic browser setup: `docs/sdk/react.md`.

---

## Phase 5 — Make it reach a human

A GlitchTip alert rule with a webhook recipient posts to the relay; the relay enriches the
event and posts to Telegram. GlitchTip has **no** native Telegram recipient — the relay is not
optional decoration, it is the delivery mechanism.

**Companion setup goes through the Mac app.** Send the user to `docs/operations/install.md`: the app deploys the relay to the Linux server over SSH and keeps secrets in the macOS Keychain. Never run the relay on macOS, and never ask for or accept a Telegram or GlitchTip token in the conversation; if the user offers one, tell them not to paste it and to enter it in the app. Investigating an incident is a separate job: use the project-local `glitchtip-investigate` skill with the brief from Telegram (`docs/operations/agent-handoff.md`).

`assets/relay/server.js` is a zero-dependency multi-project relay. It routes by GlitchTip
**project slug**, so one relay serves every project on the instance. Configure it with:

```
PROJECT_APP_BASES = {"myapp": {"production": "https://myapp.com", "staging": "https://staging.myapp.com"}}
```

A project absent from that map still gets a correctly-labelled alert; it just skips the
user-context enrichment. **Degrade, never drop.**

The relay renders severity-specific messages: urgent red for errors, amber for warnings, blue
for info, and a neutral fallback for unknown webhook shapes. Its Telegram HTML formatter
escapes every payload-derived value. Configure the normal GlitchTip alert policy for errors
and warnings. Forward info events only when the project deliberately wants that volume.

### Two channels, on purpose

Keep both, and do not let one absorb the other:

| Channel | Fires on | Carries |
|---|---|---|
| **GlitchTip → relay → Telegram** | an error or selected warning/info event, grouped and deduped | severity, stack, trail, release, browser, who |
| **App-side direct Telegram** | a condition the app *detects* — health check failed, a queue backed up, a deploy finished | a short, deliberate message |

The second is not redundant: a degraded-but-not-throwing system produces no exception, so
GlitchTip has nothing to send. Template: `assets/templates/*/alerting.*`.

Both must be **fire-and-forget, deduped, and never able to throw**.

---

## Phase 6 — Prove it (this phase is the deliverable)

An install is not done until an error you caused appears in Telegram. Run:

```bash
python3 assets/verify.py --project myapp --expect-telegram
```

It checks, in order, and reports each as PASS/FAIL with the evidence:

1. `{base}/api/0/` authenticates.
2. The project exists and has at least one key.
3. An alert rule exists with a webhook recipient.
4. The relay answers on its configured URL.
5. A synthetic event, sent to the real DSN, appears in the project's issue list within the
   poll window.
6. That event's payload contains **no** frame locals and none of the scrub patterns.
7. The alert rule's test fire returns 2xx.

**If step 6 fails, treat the install as failed even though alerts are arriving.** Delivery
without scrubbing is worse than no delivery: it is an ongoing export of user data with a
convincing appearance of being correctly configured.

Then confirm by eye that a message actually landed in the Telegram group, and that its project
label is **this** project. A relay serving several projects and labelling them all with the
first one's name is the specific defect this skill exists to prevent.

---

## Phase 7 — Record it so the next person inherits a system, not a mystery

Add to the project's `AGENTS.md` / `CLAUDE.md` (create the section if absent):

- which instance, which org, which project slug;
- that errors live in **GlitchTip, not Sentry.io**, so no agent wires a Sentry.io connector;
- which Telegram group receives alerts;
- the scrubbing rule, in one sentence, phrased as a constraint on future code
  (e.g. "never put user content in an alert body");
- the env keys, in `.env.example`, with empty values.

Then delete nothing else. Leave the previous alert path in place.

---

## Definition of done

- [ ] Backend init is env-gated, never throws, tags environment + release, and the release value
      is confirmed **in the running process**
- [ ] Python has `include_local_variables=False`, `before_send`, and `before_breadcrumb`;
      JavaScript uses the package scrubber; either path has tests using real context shapes
- [ ] Every streaming handler captures explicitly in its `except`
- [ ] Browser reporter is wired, noise filtered, and carries only opaque user identity
- [ ] Browser SDK loaded so that a failure in it cannot unmount the app
- [ ] Alert rule exists with a webhook recipient pointing at the relay
- [ ] Relay knows this project's slug and app bases
- [ ] `verify.py` passes all seven checks
- [ ] A real message with the correct project label was seen in Telegram
- [ ] Env keys documented; instance/org/project/group recorded in the project's agent docs

Report which of these you checked and how. "Should work" is not one of the boxes.

---

## References

- `references/architecture.md` — the four layers and why each exists
- `references/api.md` — the verified GlitchTip API surface, endpoint by endpoint
- `references/relay.md` — relay deployment, the multi-project map, extending the format
- `references/edge-cases.md` — every trap this skill was built from, each with its symptom
