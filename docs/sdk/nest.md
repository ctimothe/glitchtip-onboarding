# NestJS adapter

The Nest adapter creates a global exception filter that observes exceptions and then delegates response construction to Nest's `BaseExceptionFilter`.

```ts
// main.ts
import { NestFactory } from "@nestjs/core";
import { createGlitchTipExceptionFilter } from "@glitchtip-onboarding/sdk/nest";
import { createNodeReporter } from "@glitchtip-onboarding/sdk/node";

import { AppModule } from "./app.module";

async function bootstrap() {
  const telemetry = createNodeReporter({
    dsn: process.env.GLITCHTIP_DSN,
    project: "accounts-api",
    environment: process.env.APP_ENV ?? "development",
    release: process.env.APP_RELEASE,
  });
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(
    createGlitchTipExceptionFilter(telemetry, app.getHttpAdapter()),
  );
  await app.listen(3000);
}

void bootstrap();
```

Passing `app.getHttpAdapter()` lets Nest preserve its platform-specific status codes and response bodies. The filter captures method, route pattern, status, and an existing request ID. It does not copy headers, queries, cookies, bodies, or the request object.

Exceptions inside observables, event consumers, scheduled jobs, and streams may not cross the HTTP exception filter. Capture them where they are handled:

```ts
try {
  await runScheduledImport();
} catch (error) {
  telemetry.reportError(error, {
    tags: { framework: "nest", process: "scheduled-import" },
  });
  throw error;
}
```
