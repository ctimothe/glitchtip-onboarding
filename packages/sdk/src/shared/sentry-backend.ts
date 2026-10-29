import { scrubValue } from "./scrub.js";
import type {
  CaptureBackend,
  CapturePayload,
  ReporterConfig,
  Severity,
} from "./types.js";

interface ScopeLike {
  setLevel(level: Severity): unknown;
  setTags(tags: CapturePayload["tags"]): unknown;
  setExtras(extra: Record<string, unknown>): unknown;
  setUser(user: { id: string; role?: string }): unknown;
  setFingerprint(fingerprint: string[]): unknown;
}

export interface SentryLike {
  withScope<T>(callback: (scope: ScopeLike) => T): T;
  captureException(error: Error): string;
  captureMessage(message: string): string;
  flush(timeoutMs: number): PromiseLike<boolean>;
}

function applyPayload(scope: ScopeLike, payload: CapturePayload): void {
  scope.setLevel(payload.level);
  scope.setTags(payload.tags);
  if (payload.extra) scope.setExtras(payload.extra);
  if (payload.user) scope.setUser(payload.user);
  if (payload.fingerprint) scope.setFingerprint(payload.fingerprint);
}

export function createSentryBackend(sdk: SentryLike): CaptureBackend {
  return {
    captureException(error, payload) {
      return sdk.withScope((scope) => {
        applyPayload(scope, payload);
        return sdk.captureException(error);
      });
    },
    captureMessage(message, payload) {
      return sdk.withScope((scope) => {
        applyPayload(scope, payload);
        return sdk.captureMessage(message);
      });
    },
    async flush(timeoutMs) {
      return await sdk.flush(timeoutMs);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripFrameVariables(stacktrace: unknown): void {
  if (!isRecord(stacktrace) || !Array.isArray(stacktrace.frames)) return;
  for (const frame of stacktrace.frames) {
    if (isRecord(frame)) delete frame.vars;
  }
}

function stripLocalVariables(event: Record<string, unknown>): void {
  stripFrameVariables(event.stacktrace);
  for (const containerName of ["exception", "threads"]) {
    const container = event[containerName];
    if (!isRecord(container) || !Array.isArray(container.values)) continue;
    for (const value of container.values) {
      if (isRecord(value)) stripFrameVariables(value.stacktrace);
    }
  }
}

const URL_LIKE_DATA_KEYS = ["url", "to", "from"];

function stripQueryFromUrlLikeData(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const next = { ...data };
  for (const key of URL_LIKE_DATA_KEYS) {
    if (typeof next[key] === "string") next[key] = (next[key] as string).split("?")[0];
  }
  return next;
}

function scrubBreadcrumbs(breadcrumbs: unknown, config: ReporterConfig): unknown {
  if (!Array.isArray(breadcrumbs)) return breadcrumbs;
  return breadcrumbs.map((crumb) => {
    if (!isRecord(crumb)) return crumb;
    const next = { ...crumb };
    // Breadcrumbs come from the SDK's own fetch/xhr/history/click instrumentation, not
    // from a trusted server route table, so query strings must be stripped before the
    // generic scrubber runs (which only catches credential-*shaped* values, not every
    // query parameter).
    if ("data" in next) next.data = scrubValue(stripQueryFromUrlLikeData(next.data), config.scrub);
    if (typeof next.message === "string") next.message = scrubValue(next.message, config.scrub);
    return next;
  });
}

function scrubExceptionMessages(exception: unknown, config: ReporterConfig): unknown {
  if (!isRecord(exception) || !Array.isArray(exception.values)) return exception;
  return {
    ...exception,
    values: exception.values.map((value) => {
      if (!isRecord(value) || typeof value.value !== "string") return value;
      return { ...value, value: scrubValue(value.value, config.scrub) };
    }),
  };
}

export function sanitizeEvent(event: unknown, config: ReporterConfig): unknown {
  if (!isRecord(event)) return event;

  // Redact sensitive *keys* everywhere (password, token, ...), but skip value-pattern
  // matching on this full-event pass: structural Sentry fields (event_id, trace_id,
  // stack frame filenames, ...) are not caller-controlled secrets and must survive
  // ingestion. Pattern matching is applied below only to caller-controlled containers.
  const scrubbed = scrubValue(event, {
    ...config.scrub,
    matchPatterns: false,
    maxDepth: Math.max(config.scrub?.maxDepth ?? 6, 12),
  }) as Record<string, unknown>;
  if (!isRecord(scrubbed)) return scrubbed;

  if ("extra" in event) scrubbed.extra = scrubValue(event.extra, config.scrub);
  if ("breadcrumbs" in event) scrubbed.breadcrumbs = scrubBreadcrumbs(event.breadcrumbs, config);
  if (isRecord(event.exception)) scrubbed.exception = scrubExceptionMessages(event.exception, config);
  if (typeof event.message === "string") {
    scrubbed.message = scrubValue(event.message, config.scrub);
  }

  stripLocalVariables(scrubbed);

  if (isRecord(scrubbed.request)) {
    delete scrubbed.request.data;
    delete scrubbed.request.cookies;
    delete scrubbed.request.headers;
    delete scrubbed.request.query_string;
    delete scrubbed.request.env;
    if (typeof scrubbed.request.url === "string") {
      scrubbed.request.url = scrubbed.request.url.split("?")[0];
    }
  }
  if (isRecord(event.user)) {
    scrubbed.user = {
      ...(typeof event.user.id === "string" ? { id: event.user.id } : {}),
      ...(typeof event.user.role === "string" ? { role: event.user.role } : {}),
    };
  } else {
    delete scrubbed.user;
  }
  return scrubbed;
}

export function makeBeforeSend(
  config: ReporterConfig,
  shouldDrop: (event: unknown) => boolean = () => false,
): (event: unknown) => unknown | null {
  return (event) => {
    try {
      if (shouldDrop(event)) return null;
      const sanitized = sanitizeEvent(event, config);
      return config.beforeSend ? config.beforeSend(sanitized) : sanitized;
    } catch {
      return null;
    }
  };
}
