import * as Sentry from "@sentry/node";

import { normalizeError } from "../shared/normalize.js";
import { createReporter } from "../shared/reporter.js";
import { createSentryBackend, makeBeforeSend } from "../shared/sentry-backend.js";
import type { Reporter, ReporterConfig } from "../shared/types.js";

export type { ReportContext, Reporter, ReporterConfig, ScrubConfig } from "../shared/types.js";

// Sentry.init configures a per-runtime global client, so a second init in the
// same module silently replaces the previous configuration. Latch module state
// to surface that exactly once: `hasInitialized` is only set after Sentry.init
// returns without throwing (a failed init leaves it untouched), and `warned`
// keeps repeated re-initialization from storming the console.
let hasInitialized = false;
let warned = false;

export function createNodeReporter(config: ReporterConfig): Reporter {
  // A blank project or environment means events cannot be routed or distinguished
  // (spec: "project and environment are required"). Disable rather than ship
  // silently mis-tagged events, unless the caller explicitly forced enabled.
  const explicitEnabled = config.enabled === true;
  const blankIdentity = !config.project?.trim() || !config.environment?.trim();
  let enabled = config.enabled !== false && Boolean(config.dsn?.trim());
  if (enabled && blankIdentity && !explicitEnabled) enabled = false;
  if (enabled) {
    try {
      const options: Sentry.NodeOptions = {
        dsn: config.dsn!,
        environment: config.environment,
        debug: config.debug ?? false,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        defaultIntegrations: false,
        integrations: [
          Sentry.inboundFiltersIntegration(),
          Sentry.functionToStringIntegration(),
          Sentry.linkedErrorsIntegration(),
          Sentry.dedupeIntegration(),
        ],
        beforeSend: makeBeforeSend(config) as NonNullable<Sentry.NodeOptions["beforeSend"]>,
      };
      if (config.release) options.release = config.release;
      Sentry.init(options);
      if (hasInitialized && !warned) {
        warned = true;
        console.warn(
          "@glitchtip-onboarding/sdk/node: createNodeReporter initialized a second reporter — the Sentry client is a per-runtime singleton and the newest config replaces the previous one. Create one reporter per runtime.",
        );
      }
      hasInitialized = true;
    } catch {
      enabled = false;
    }
  }

  return createReporter(
    createSentryBackend(Sentry as unknown as Parameters<typeof createSentryBackend>[0]),
    { ...config, enabled },
  );
}

type EnvironmentOverrides = Partial<ReporterConfig>;

export function nodeConfigFromEnv(
  env: NodeJS.ProcessEnv,
  overrides: EnvironmentOverrides = {},
): ReporterConfig {
  const project = overrides.project ?? env.GLITCHTIP_PROJECT ?? "";
  const environment = overrides.environment ?? env.APP_ENV ?? "";
  const config: ReporterConfig = { project, environment };
  const dsn = overrides.dsn ?? env.GLITCHTIP_DSN;
  const release = overrides.release ?? env.APP_RELEASE;
  if (dsn !== undefined) config.dsn = dsn;
  if (release !== undefined) config.release = release;
  if (overrides.enabled !== undefined) config.enabled = overrides.enabled;
  // A blank project or environment means events cannot be routed or distinguished
  // (spec: "project and environment are required"). Disable rather than ship
  // silently mis-tagged events, unless the caller explicitly forced enabled above.
  else if (!project || !environment) config.enabled = false;
  if (overrides.debug !== undefined) config.debug = overrides.debug;
  if (overrides.scrub !== undefined) config.scrub = overrides.scrub;
  if (overrides.beforeSend !== undefined) config.beforeSend = overrides.beforeSend;
  return config;
}

export interface ProcessErrorHandlerOptions {
  flushTimeoutMs?: number;
  onFatal?: (error: Error) => void | Promise<void>;
}

export function installProcessErrorHandlers(
  reporter: Reporter,
  options: ProcessErrorHandlerOptions = {},
): () => void {
  const finish = async (value: unknown, mechanism: string): Promise<void> => {
    const error = normalizeError(value);
    reporter.reportError(error, { tags: { mechanism } });
    await reporter.flush(options.flushTimeoutMs ?? 2000);
    if (options.onFatal) await options.onFatal(error);
    else process.exitCode = 1;
  };

  const onUncaughtException = (error: Error): void => {
    void finish(error, "uncaughtException");
  };
  const onUnhandledRejection = (reason: unknown): void => {
    void finish(reason, "unhandledRejection");
  };

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
  };
}
