export const INSTALL_CMD = "npm install @glitchtip-onboarding/sdk";

export const GITHUB_URL = "https://github.com/ctimothe/glitchtip-onboarding";

export const hero = {
  title: "A real error, in production, reaches a human.",
  sub: "glitchtip-onboarding wires GlitchTip observability end to end — SDK, alert rules, Telegram routing, live verification — so a production error arrives with enough context to fix it, and without carrying user data out of the box.",
};

export type QuickstartTab = { id: string; label: string; lang: string; code: string };

export const quickstartTabs: QuickstartTab[] = [
  {
    id: "node",
    label: "Node",
    lang: "ts",
    // Verbatim from docs/sdk/getting-started.md, "Configure a Node.js process".
    code: `import { createNodeReporter } from "@glitchtip-onboarding/sdk/node";

export const telemetry = createNodeReporter({
  dsn: process.env.GLITCHTIP_DSN,
  project: "billing-api",
  environment: process.env.APP_ENV ?? "development",
  release: process.env.APP_RELEASE,
});`,
  },
  {
    id: "react",
    label: "React",
    lang: "tsx",
    // Verbatim provider usage from docs/sdk/react.md (main.tsx sample).
    code: `// main.tsx
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
);`,
  },
  {
    id: "next",
    label: "Next.js",
    lang: "ts",
    // Verbatim from docs/sdk/next.md (withRouteErrorCapture route-handler sample).
    code: `// app/api/orders/route.ts
import { withRouteErrorCapture } from "@glitchtip-onboarding/sdk/next";

import { serverTelemetry } from "../../../telemetry.server";

export const POST = withRouteErrorCapture(serverTelemetry, async (request: Request) => {
  const order = await createOrder(request);
  return Response.json(order, { status: 201 });
});`,
  },
  {
    id: "express",
    label: "Express",
    lang: "ts",
    // Verbatim from docs/sdk/express.md (imports, reporter, createExpressErrorMiddleware).
    code: `import express from "express";
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
});`,
  },
  {
    id: "fastify",
    label: "Fastify",
    lang: "ts",
    // Verbatim from docs/sdk/fastify.md (imports, reporter, createFastifyErrorHook).
    code: `import Fastify from "fastify";
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

await app.listen({ port: 3000 });`,
  },
  {
    id: "nest",
    label: "NestJS",
    lang: "ts",
    // Verbatim from docs/sdk/nest.md (imports, reporter, createGlitchTipExceptionFilter).
    code: `// main.ts
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

void bootstrap();`,
  },
];

export const transportTrio = {
  lang: "ts",
  // Verbatim subset of docs/sdk/getting-started.md, "Report events".
  code: `telemetry.reportError(new Error("Invoice generation failed"), { requestId: "req-42" });
telemetry.reportWarning("Payment retrying", { tags: { attempt: 2 } });
telemetry.reportInfo("Customer completed onboarding", { user: { id: "opaque-user-17" } });`,
};

export const scrubFixture = {
  lang: "json",
  // Derived from packages/sdk/src/shared/scrub.ts rules (email pattern, redact keys, [REDACTED]).
  before: `{
  "user": { "email": "ana@example.com" },
  "extra": { "api_key": "sk_live_abc123", "attempt": 2 }
}`,
  after: `{
  "user": { "email": "[REDACTED]" },
  "extra": { "api_key": "[REDACTED]", "attempt": 2 }
}`,
  input: { user: { email: "ana@example.com" }, extra: { api_key: "sk_live_abc123", attempt: 2 } },
};

export const relayFixture = {
  header: "🚨 [billing-api·production] · 3× · Error",
  title: "Invoice generation failed",
  rows: ["📍 Page: /checkout", "🧵 Request: req-42", "👤 user opaque-user-17 (customer)"],
  source: "chargeInvoices — app/api/billing.ts:87",
};

export const verifyFacts = {
  // Verbatim facts from assets/verify.py docstring and record().
  command: "python3 assets/verify.py --project myapp --fire",
  marker: "glitchtip-onboarding verification event",
  check6: "Check 6 — scrubbing — fails the whole run when user data would be exported.",
  verdict: "Every check prints PASS/FAIL with the evidence that decided it.",
};
