# @glitchtip-onboarding/sdk

Privacy-first error, warning, and informational reporting for GlitchTip. Import the runtime or framework adapter your application uses.

```ts
import { createNodeReporter } from "@glitchtip-onboarding/sdk/node";

const reporter = createNodeReporter({
  dsn: process.env.GLITCHTIP_DSN,
  project: "my-app",
  environment: process.env.APP_ENV ?? "development",
  release: process.env.APP_RELEASE,
});

reporter.reportError(new Error("Something failed"));
reporter.reportWarning("A retry was scheduled");
reporter.reportInfo("A job completed");
```

Framework entry points are available at `/react`, `/next`, `/express`, `/nest`, and `/fastify`. The package disables tracing, replay, profiling, default PII, request headers, request bodies, cookies, and query strings.
