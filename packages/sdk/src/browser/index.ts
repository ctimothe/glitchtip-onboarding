import * as Sentry from "@sentry/browser";

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

const NOISE_PATTERNS = [
  /resizeobserver loop/i,
  /^script error\.?$/i,
];
const EXTENSION_PATTERN = /^(?:chrome|moz|safari-web)-extension:\/\//i;

function eventStrings(event: unknown): string[] {
  if (!event || typeof event !== "object") return [];
  const value = event as {
    message?: unknown;
    title?: unknown;
    culprit?: unknown;
    request?: { url?: unknown };
    exception?: { values?: Array<{ type?: unknown; value?: unknown; stacktrace?: { frames?: Array<{ filename?: unknown; abs_path?: unknown }> } }> };
  };
  const strings = [value.message, value.title, value.culprit, value.request?.url];
  for (const exception of value.exception?.values ?? []) {
    strings.push(exception.type, exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      strings.push(frame.filename, frame.abs_path);
    }
  }
  return strings.filter((item): item is string => typeof item === "string");
}

export function isBenignBrowserEvent(event: unknown): boolean {
  return eventStrings(event).some(
    (value) =>
      NOISE_PATTERNS.some((pattern) => pattern.test(value)) ||
      /\baborterror\b/i.test(value) ||
      EXTENSION_PATTERN.test(value),
  );
}

export interface BrowserEnvironment {
  NEXT_PUBLIC_GLITCHTIP_DSN?: string;
  VITE_GLITCHTIP_DSN?: string;
}

type BrowserEnvironmentOverrides = Partial<ReporterConfig> &
  Pick<ReporterConfig, "project" | "environment">;

export function browserConfigFromEnv(
  env: BrowserEnvironment,
  overrides: BrowserEnvironmentOverrides,
): ReporterConfig {
  const config: ReporterConfig = {
    project: overrides.project,
    environment: overrides.environment,
  };
  const dsn =
    overrides.dsn ?? env.NEXT_PUBLIC_GLITCHTIP_DSN ?? env.VITE_GLITCHTIP_DSN;
  if (dsn !== undefined) config.dsn = dsn;
  if (overrides.release !== undefined) config.release = overrides.release;
  if (overrides.enabled !== undefined) config.enabled = overrides.enabled;
  if (overrides.debug !== undefined) config.debug = overrides.debug;
  if (overrides.scrub !== undefined) config.scrub = overrides.scrub;
  if (overrides.beforeSend !== undefined) config.beforeSend = overrides.beforeSend;
  return config;
}

export function createBrowserReporter(config: ReporterConfig): Reporter {
  // A blank project or environment means events cannot be routed or distinguished
  // (spec: "project and environment are required"). Disable rather than ship
  // silently mis-tagged events, unless the caller explicitly forced enabled.
  const explicitEnabled = config.enabled === true;
  const blankIdentity = !config.project?.trim() || !config.environment?.trim();
  let enabled = config.enabled !== false && Boolean(config.dsn?.trim());
  if (enabled && blankIdentity && !explicitEnabled) enabled = false;
  if (enabled) {
    try {
      const options: Sentry.BrowserOptions = {
        dsn: config.dsn!,
        environment: config.environment,
        debug: config.debug ?? false,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        defaultIntegrations: false,
        maxBreadcrumbs: 50,
        integrations: [
          Sentry.inboundFiltersIntegration(),
          Sentry.functionToStringIntegration(),
          // console and dom are off: console output and raw DOM click targets are not
          // curated, and can carry whatever an application chooses to log or render.
          // fetch/xhr/history stay on because the "what led to it" trail is the point of
          // capturing errors at all; sanitizeEvent strips query strings and redacts
          // credential-shaped values from their `data` before an event ever leaves.
          Sentry.breadcrumbsIntegration({ console: false, dom: false, fetch: true, history: true, xhr: true }),
          Sentry.linkedErrorsIntegration(),
          Sentry.dedupeIntegration(),
          Sentry.globalHandlersIntegration({ onerror: true, onunhandledrejection: true }),
        ],
        beforeSend: makeBeforeSend(config, isBenignBrowserEvent) as NonNullable<
          Sentry.BrowserOptions["beforeSend"]
        >,
      };
      if (config.release) options.release = config.release;
      Sentry.init(options);
      if (hasInitialized && !warned) {
        warned = true;
        console.warn(
          "@glitchtip-onboarding/sdk/browser: createBrowserReporter initialized a second reporter — the Sentry client is a per-runtime singleton and the newest config replaces the previous one. Create one reporter per runtime.",
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

const CLICKABLE_SELECTOR =
  'button, a, [role="button"], [role="tab"], [role="menuitem"], input, select, label, [data-testid]';

/**
 * Opt-in: record the accessible label of a clicked control as a breadcrumb, so an alert's
 * trail reads `clicked "Search"` instead of stopping at the last network call. Never
 * installed implicitly — call it once from the application entry point after
 * `createBrowserReporter`. Wrapped so a malformed element can never break a real click.
 */
export function installClickBreadcrumbs(): () => void {
  if (typeof document === "undefined") return () => {};
  const onClick = (event: MouseEvent): void => {
    try {
      const target = event.target as Element | null;
      const el = target?.closest?.(CLICKABLE_SELECTOR);
      if (!el) return;
      const raw =
        el.getAttribute("aria-label") ||
        (el as HTMLElement).innerText ||
        el.getAttribute("title") ||
        el.getAttribute("data-testid") ||
        el.tagName.toLowerCase();
      const label = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!label) return;
      Sentry.addBreadcrumb({
        category: "ui.click",
        message: label,
        level: "info",
        data: { element: el.tagName.toLowerCase() },
      });
    } catch {
      // Reporting must never break a user's click.
    }
  };
  document.addEventListener("click", onClick, { capture: true });
  return () => document.removeEventListener("click", onClick, { capture: true });
}
