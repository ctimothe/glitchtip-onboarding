# The four layers

Error observability that actually works is four separate things. Most installs build one and
call it done.

```
  ┌─ 1. CAPTURE ────────────────────────────────────────────────────────────┐
  │  @glitchtip-onboarding/sdk (Node + browser + framework adapters)         │
  │  native-language SDKs (API + workers + cron + CLI)                       │
  │  ⚠️ streaming handlers, which the framework error handler NEVER sees     │
  └────────────────────────────────────────────────────────────────────────┘
                    │  (scrubbed here, before anything leaves the process)
                    ▼
  ┌─ 2. TRANSPORT ─────────────────────────────────────────────────────────┐
  │  direct to the instance   —or—   same-origin tunnel (beats ad blockers) │
  └────────────────────────────────────────────────────────────────────────┘
                    ▼
  ┌─ 3. STORE + GROUP ─────────────────────────────────────────────────────┐
  │  GlitchTip: dedupe, group, count, tag by release/environment            │
  │  a dashboard — and nobody looks at a dashboard at 2am                   │
  └────────────────────────────────────────────────────────────────────────┘
                    │  alert rule, webhook recipient
                    ▼
  ┌─ 4. REACH A HUMAN ─────────────────────────────────────────────────────┐
  │  relay: enrich from the API, resolve WHO from the app, post to Telegram │
  └────────────────────────────────────────────────────────────────────────┘

  ── and, beside all of it ──
  ┌─ APP-SIDE ALERTS ──────────────────────────────────────────────────────┐
  │  conditions the app DETECTS: health check failed, queue backed up,      │
  │  deploy finished. Nothing threw, so layer 1 has nothing to capture.     │
  └────────────────────────────────────────────────────────────────────────┘
```

## Why layer 4 is not optional

GlitchTip has **no Telegram recipient type** — verified in the live OpenAPI schema. Webhook is
the only outbound integration that reaches a chat app, so something has to receive that webhook
and format it. That something is the relay.

The relay also solves a privacy problem. If GlitchTip stored names and phone numbers, every
person with dashboard access would see them, and they would sit in the error store's database
indefinitely. Instead the SDK sends an **opaque user id**, and the relay resolves the human
identity at alert time from the app's own token-guarded endpoint. The identity appears once, in
a private Telegram message, and is never stored in the error tracker.

That is the whole reason for `GET /api/observability/user-context/:id`. A project that does not
implement it still gets alerts — just without the WHO section.

## The reusable capture layer

JavaScript and TypeScript applications install `@glitchtip-onboarding/sdk` instead of copying
telemetry snippets. The Node and browser entry points create the GlitchTip transport; React,
Next.js, Express, NestJS, and Fastify adapters translate framework error surfaces into the
same `Reporter` contract.

Every event receives `event_kind`, `project`, and `environment` tags, plus release, request ID,
opaque user identity, and compact diagnostic context when supplied. Errors capture exceptions;
warnings and info events capture structured messages with stable default fingerprints. All
paths use the same recursive scrubber before the underlying Sentry-compatible transport sees
the event.

Subpath exports are a runtime boundary. Browser bundles import `/browser` and `/react`; server
processes import `/node` and their framework adapter. Package smoke tests reject Node references
inside the browser bundles.

## Why the app-side channel stays

The two channels answer different questions:

| | GlitchTip → relay → Telegram | App-side direct Telegram |
|---|---|---|
| fires on | an unhandled exception | a condition the app checks for |
| grouping | GlitchTip's fingerprinting | a dedupe key you choose |
| carries | stack, trail, release, browser, who | a short, deliberate line |
| answers | "what broke?" | "is it healthy?" |

A system that is degraded but not throwing produces **zero** exceptions. A deploy that silently
did not happen throws nothing. A backup job that has failed for a week throws nothing. Only the
second channel can see those.

Keep both. Do not let an install of one delete the other.

## The same-origin tunnel

Optional, and worth it for consumer-facing apps.

Browser extensions and ad blockers maintain lists that include error-reporting hosts. Requests
to them are dropped before they leave the browser, so a share of real users' errors — exactly
the users you cannot ask — never arrive. Routing the envelope through your own origin makes the
request first-party, which those lists do not block, and removes CORS from the picture.

The endpoint takes a raw Sentry envelope (`application/x-sentry-envelope`, **not** JSON — a
global JSON body parser ignores that content type, which is why the stream survives to be read
as text), extracts the DSN from the envelope header, and **must reject any envelope whose DSN
key is not yours**. Without that check you have built an open relay that anyone can point at
your instance.

## Where scrubbing goes

In layer 1, before transport, in the process that produced the error. Not in the relay, not in
a retention policy. Once an event has left the process it is stored, indexed and replicated;
"we'll filter it on the way out" is not a control.
