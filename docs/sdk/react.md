# React adapter

The React adapter provides a reporter context, a hook for manual events, and an error boundary for render and lifecycle errors.

## Keep the telemetry SDK out of the entry chunk

Create a stable proxy that the React tree can use immediately, then load the browser SDK without delaying the first render:

```ts
// telemetry.ts
import type { ReportContext, Reporter } from "@glitchtip-onboarding/sdk/react";

let activeReporter: Reporter | undefined;

export const telemetry: Reporter = {
  reportError(error: unknown, context?: ReportContext) {
    return activeReporter?.reportError(error, context);
  },
  reportWarning(message: string, context?: ReportContext) {
    return activeReporter?.reportWarning(message, context);
  },
  reportInfo(message: string, context?: ReportContext) {
    return activeReporter?.reportInfo(message, context);
  },
  flush(timeoutMs?: number) {
    return activeReporter?.flush(timeoutMs) ?? Promise.resolve(false);
  },
};

export async function initializeTelemetry(): Promise<void> {
  try {
    const { createBrowserReporter, installClickBreadcrumbs } = await import("@glitchtip-onboarding/sdk/browser");
    activeReporter = createBrowserReporter({
      dsn: import.meta.env.VITE_GLITCHTIP_DSN,
      project: "shop-web",
      environment: import.meta.env.VITE_APP_ENV ?? "development",
      release: import.meta.env.VITE_APP_RELEASE,
    });
    installClickBreadcrumbs();
  } catch {
    // Observability cannot be allowed to break application startup.
  }
}
```

For a non-Vite build, replace the `import.meta.env` names with the build tool's public environment mechanism. Public browser DSNs are ingest identifiers, but tokens and other credentials must never enter browser variables.

`createBrowserReporter` records fetch, XHR, and navigation breadcrumbs (with query strings stripped before an event ever leaves the process) so an alert shows what led to the error. `installClickBreadcrumbs()` is optional and additive: it records only the accessible label of a clicked control (e.g. `clicked "Search"`), never raw DOM content, and is safe to skip if you don't want click tracking at all.

## Install the provider and boundary

```tsx
// main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import {
  ObservabilityErrorBoundary,
  ObservabilityProvider,
} from "@glitchtip-onboarding/sdk/react";

import { App } from "./App";
import { initializeTelemetry, telemetry } from "./telemetry";

void initializeTelemetry();

createRoot(document.getElementById("root")!).render(
  <ObservabilityProvider reporter={telemetry}>
    <ObservabilityErrorBoundary fallback={<p>Something went wrong. Please reload.</p>}>
      <App />
    </ObservabilityErrorBoundary>
  </ObservabilityProvider>,
);
```

Errors thrown before the deferred SDK finishes loading remain disabled rather than being queued with potentially sensitive state. Once initialized, the browser reporter captures global errors and unhandled promise rejections as well as boundary errors.

Use a render-function fallback when the interface can recover without a reload:

```tsx
<ObservabilityErrorBoundary
  fallback={({ reset }) => (
    <button type="button" onClick={reset}>
      Try again
    </button>
  )}
>
  <Checkout />
</ObservabilityErrorBoundary>
```

The application should change or clear the failed state before calling `reset`; otherwise the child throws again immediately.

## Manual reporting from a component

```tsx
import { useReporter } from "@glitchtip-onboarding/sdk/react";

export function RetryButton() {
  const reporter = useReporter();

  return (
    <button
      type="button"
      onClick={() => {
        reporter.reportInfo("Customer requested a retry", {
          tags: { surface: "checkout" },
        });
      }}
    >
      Retry
    </button>
  );
}
```
