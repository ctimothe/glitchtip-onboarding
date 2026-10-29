# Fastify adapter

Install the returned `onError` hook after creating the reporter. The hook observes errors and calls `done()` without sending or replacing a response.

```ts
import Fastify from "fastify";
import { createFastifyErrorHook } from "@glitchtip-onboarding/sdk/fastify";
import { createNodeReporter } from "@glitchtip-onboarding/sdk/node";

const telemetry = createNodeReporter({
  dsn: process.env.GLITCHTIP_DSN,
  project: "jobs-api",
  environment: process.env.APP_ENV ?? "development",
  release: process.env.APP_RELEASE,
});

const app = Fastify();
app.addHook("onError", createFastifyErrorHook(telemetry));

app.get("/jobs/:id", async (request) => {
  return await loadJob(request.params.id);
});

await app.listen({ port: 3000 });
```

The hook records the method, route pattern, status, and Fastify request ID. It never copies the URL, query, headers, cookies, body, or request object.

Errors raised after a stream or hijacked response begins may bypass normal error handling. Capture them at the stream boundary:

```ts
try {
  await pipeDownload(reply.raw);
} catch (error) {
  telemetry.reportError(error, {
    requestId: request.id,
    tags: { framework: "fastify", operation: "download-stream" },
  });
  reply.raw.end();
}
```
