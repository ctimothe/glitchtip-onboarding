# Getting started with the JavaScript SDK

`@glitchtip-onboarding/sdk` gives JavaScript and TypeScript applications one reporting API for GlitchTip errors, warnings, and informational events.

## Install

```bash
npm install @glitchtip-onboarding/sdk
```

The package is currently built from this repository. Before its first registry release, create a tarball with `npm pack -w @glitchtip-onboarding/sdk` and install that `.tgz` file in the target application.

## Configure a Node.js process

Create the reporter after environment variables load and before importing application code that can fail:

```ts
import { createNodeReporter } from "@glitchtip-onboarding/sdk/node";

export const telemetry = createNodeReporter({
  dsn: process.env.GLITCHTIP_DSN,
  project: "billing-api",
  environment: process.env.APP_ENV ?? "development",
  release: process.env.APP_RELEASE,
});
```

Use a separate DSN for each GlitchTip project. Set `APP_ENV` explicitly to values such as `production`, `staging`, or `development`; build mode alone does not identify the deployed environment reliably.

A missing or blank DSN, project, or environment creates a silent disabled reporter — project and environment must be set so every event can be routed and distinguished correctly. Pass `enabled: true` explicitly to override that safeguard. Initialization and capture failures never interrupt application code.

When configuration already lives in environment variables, use the helper:

```ts
import { createNodeReporter, nodeConfigFromEnv } from "@glitchtip-onboarding/sdk/node";

export const telemetry = createNodeReporter(nodeConfigFromEnv(process.env));
```

It reads `GLITCHTIP_DSN`, `GLITCHTIP_PROJECT`, `APP_ENV`, and `APP_RELEASE`. Explicit override
values passed as the second argument take precedence.

## Report events

```ts
telemetry.reportError(new Error("Invoice generation failed"), {
  requestId: "req-42",
  tags: { queue: "invoices" },
  extra: { attempt: 2, provider: "example-payments" },
});

telemetry.reportWarning("Payment retrying", {
  requestId: "req-42",
  tags: { attempt: 2 },
});

telemetry.reportInfo("Customer completed onboarding", {
  user: { id: "opaque-user-17", role: "customer" },
});
```

Errors include exception data and a stack trace. Warnings and info events use their normalized message as a stable default fingerprint. Errors and warnings can trigger the normal GlitchTip alert rule; info events are stored for investigation and should reach Telegram only through an alert rule deliberately configured for them.

JavaScript can throw values other than `Error`. `reportError` accepts `unknown` and converts strings or objects into safe errors.

## Short-lived jobs

Long-running servers let the underlying transport send in the background. A CLI command, cron task, or one-shot worker should flush before exiting:

```ts
try {
  await runJob();
} catch (error) {
  telemetry.reportError(error, { tags: { process: "nightly-import" } });
  await telemetry.flush(2_000);
  process.exitCode = 1;
}
```

Process-level handlers are opt-in because applications differ in how they shut down:

```ts
import { installProcessErrorHandlers } from "@glitchtip-onboarding/sdk/node";

const uninstall = installProcessErrorHandlers(telemetry, {
  flushTimeoutMs: 2_000,
  onFatal() {
    process.exitCode = 1;
  },
});
```

Call `uninstall()` during controlled teardown or in tests.

**Exit semantics change once these handlers are installed.** Node's default behavior for an uncaught exception or unhandled rejection is to crash the process. Installing `installProcessErrorHandlers` intercepts that: by default it reports the error, flushes, and only sets `process.exitCode = 1` — it does not call `process.exit()`, so the process keeps running and can keep accepting work in a state that triggered the crash in the first place. If your application should still terminate on a fatal error, call `process.exit(1)` yourself inside `onFatal`.

## Privacy contract

The SDK disables default PII collection, tracing, replay, profiling, feedback, and sessions. Before an event leaves the process, it removes request headers, bodies, cookies, query strings, and request environment data — including query strings on breadcrumb URLs recorded by the browser reporter's fetch/XHR/history instrumentation. It recursively redacts sensitive keys, email addresses, bearer tokens, API-key assignments, and credential-like strings in caller-controlled data (`extra`, breadcrumb data and messages, exception messages) without touching structural event fields (event ID, trace ID, stack frame paths) that GlitchTip needs to ingest and group events correctly.

Only an opaque user `id` and optional `role` are accepted. Do not pass names, email addresses, phone numbers, credentials, request bodies, or full user records intentionally. Scrubbing is a final guard, not a reason to collect unnecessary data.

`extra` should contain compact diagnostic values. Tags should be low-cardinality primitives that help filter events. A custom `beforeSend` hook runs after built-in scrubbing and may return `null` to drop an event.
