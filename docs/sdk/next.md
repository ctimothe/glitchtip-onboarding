# Next.js adapter

Next.js has separate server and browser error surfaces. Create one reporter for each runtime and use the adapter helper matching the surface.

## Server reporter

```ts
// telemetry.server.ts
import { createNodeReporter } from "@glitchtip-onboarding/sdk/node";

export const serverTelemetry = createNodeReporter({
  dsn: process.env.GLITCHTIP_DSN,
  project: "storefront",
  environment: process.env.APP_ENV ?? "development",
  release: process.env.APP_RELEASE,
});
```

## Instrumentation hook

The instrumentation hook receives failures from server rendering, route handlers, middleware, and server actions on supported Next.js versions:

```ts
// instrumentation.ts
import type { Instrumentation } from "next";
import { captureRequestError } from "@glitchtip-onboarding/sdk/next";

import { serverTelemetry } from "./telemetry.server";

export function register() {}

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  captureRequestError(serverTelemetry, error, request, {
    tags: {
      router_kind: context.routerKind,
      route_type: context.routeType,
      route_path: context.routePath,
    },
  });
};
```

The adapter reads `method` and `path` only. It removes a query string if one is present and never reads request headers or bodies.

## Route handlers

Wrap a route when you want explicit capture close to the operation. The wrapper preserves arguments and return values and rethrows the same error for Next.js to handle:

```ts
// app/api/orders/route.ts
import { withRouteErrorCapture } from "@glitchtip-onboarding/sdk/next";

import { serverTelemetry } from "../../../telemetry.server";

export const POST = withRouteErrorCapture(serverTelemetry, async (request: Request) => {
  const order = await createOrder(request);
  return Response.json(order, { status: 201 });
});
```

Do not apply both this wrapper and another manual `reportError` to the same catch path, or one failure will produce two events.

## App Router error components

`error.tsx` and `global-error.tsx` are client components, so they use the browser reporter described in [React adapter](./react.md):

```tsx
// app/global-error.tsx
"use client";

import { useEffect } from "react";
import { reportNextError } from "@glitchtip-onboarding/sdk/next";

import { telemetry } from "../telemetry";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  useEffect(() => {
    reportNextError(telemetry, error, {
      tags: { error_surface: "global-error", digest: error.digest ?? "none" },
    });
  }, [error]);

  return (
    <html>
      <body>
        <h2>Something went wrong</h2>
        <button type="button" onClick={reset}>Try again</button>
      </body>
    </html>
  );
}
```

## Pages Router API routes

The wrapper also accepts the structural `method` and `url` fields on a Pages Router request:

```ts
export default withRouteErrorCapture(serverTelemetry, async function handler(request, response) {
  const result = await runOperation();
  response.status(200).json(result);
});
```

Exceptions thrown while producing an already-started stream do not reach framework error handling. Capture those inside the stream's own `catch` block, flush if the process will exit, and rethrow or close the stream according to the route's protocol.
