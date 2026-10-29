# Express adapter

Initialize the Node reporter before importing modules that start jobs or register routes. Install the reporting middleware after routes and before the application's final error response middleware.

```ts
import express from "express";
import { createExpressErrorMiddleware } from "@glitchtip-onboarding/sdk/express";
import { createNodeReporter } from "@glitchtip-onboarding/sdk/node";

const telemetry = createNodeReporter({
  dsn: process.env.GLITCHTIP_DSN,
  project: "orders-api",
  environment: process.env.APP_ENV ?? "development",
  release: process.env.APP_RELEASE,
});

const app = express();

app.get("/orders/:id", async (request, response, next) => {
  try {
    const order = await loadOrder(request.params.id);
    response.json(order);
  } catch (error) {
    next(error);
  }
});

app.use(createExpressErrorMiddleware(telemetry));

app.use((error, request, response, next) => {
  response.status(500).json({ error: "Internal error" });
});
```

The middleware reports the method, route pattern, status, and an existing string `request.id`. It then calls `next(error)` without changing the error or response. It never copies the URL, query, headers, cookies, body, or request object.

Express 5 forwards rejected async handlers automatically. Express 4 requires the explicit
`try/catch` and `next(error)` shown above, or another established async-handler wrapper. The
reporting middleware can only observe errors that reach Express's error chain.

Express error middleware cannot observe an exception thrown after a streamed response has started. Capture inside the stream producer:

```ts
try {
  for await (const chunk of generateReport()) response.write(chunk);
  response.end();
} catch (error) {
  telemetry.reportError(error, {
    requestId: typeof request.id === "string" ? request.id : undefined,
    tags: { framework: "express", operation: "report-stream" },
  });
  response.end();
}
```
