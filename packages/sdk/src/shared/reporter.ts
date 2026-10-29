import { normalizeError, normalizeMessage } from "./normalize.js";
import { scrubValue } from "./scrub.js";
import type {
  CaptureBackend,
  CapturePayload,
  ReportContext,
  Reporter,
  ReporterConfig,
  Severity,
} from "./types.js";

function makePayload(
  level: Severity,
  context: ReportContext | undefined,
  config: ReporterConfig,
  message?: string,
): CapturePayload {
  const tags: CapturePayload["tags"] = {
    ...context?.tags,
    event_kind: level,
    project: config.project,
    environment: config.environment,
  };
  if (config.release) tags.release = config.release;
  if (context?.requestId) tags.request_id = context.requestId;

  const payload: CapturePayload = { level, tags };
  if (context?.extra) {
    payload.extra = scrubValue(context.extra, config.scrub) as Record<string, unknown>;
  }
  if (context?.user) {
    const id = String(scrubValue(context.user.id, config.scrub));
    payload.user = { id };
    if (context.user.role) payload.user.role = String(scrubValue(context.user.role, config.scrub));
  }
  if (context?.fingerprint) {
    payload.fingerprint = [...context.fingerprint];
  } else if (message) {
    payload.fingerprint = ["{{ default }}", message];
  }
  return payload;
}

function capture(operation: () => string | undefined): string | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

export function createReporter(backend: CaptureBackend, config: ReporterConfig): Reporter {
  const active = config.enabled !== false && Boolean(config.dsn?.trim());

  return {
    reportError(error, context) {
      if (!active) return undefined;
      return capture(() =>
        backend.captureException(normalizeError(error), makePayload("error", context, config)),
      );
    },

    reportWarning(message, context) {
      const normalized = normalizeMessage(message);
      if (!active || !normalized) return undefined;
      return capture(() =>
        backend.captureMessage(
          normalized,
          makePayload("warning", context, config, normalized),
        ),
      );
    },

    reportInfo(message, context) {
      const normalized = normalizeMessage(message);
      if (!active || !normalized) return undefined;
      return capture(() =>
        backend.captureMessage(normalized, makePayload("info", context, config, normalized)),
      );
    },

    async flush(timeoutMs = 2000) {
      if (!active) return false;
      try {
        return await backend.flush(timeoutMs);
      } catch {
        return false;
      }
    },
  };
}
