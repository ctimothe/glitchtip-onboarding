import type { ScrubConfig } from "./types.js";

const REDACTED = "[REDACTED]";
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_REDACT_KEYS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "authorization",
  "auth",
  "cookie",
  "api_key",
  "apikey",
  "session",
  "credit_card",
  "private_key",
  "private",
  "jwt",
];

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]+/i;
const KEY_ASSIGNMENT_PATTERN = /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/i;
const CREDENTIAL_PATTERN = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_+./=-]{32,}$/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldRedactKey(key: string, configured: string[]): boolean {
  const normalized = normalizeKey(key);
  return configured.some((candidate) => normalized.includes(normalizeKey(candidate)));
}

function scrubString(value: string, matchPatterns: boolean): string {
  if (!matchPatterns) return value;
  if (
    EMAIL_PATTERN.test(value) ||
    BEARER_PATTERN.test(value) ||
    KEY_ASSIGNMENT_PATTERN.test(value) ||
    CREDENTIAL_PATTERN.test(value)
  ) {
    return REDACTED;
  }
  return value;
}

export function scrubValue(value: unknown, config: ScrubConfig = {}): unknown {
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const redactKeys = [...DEFAULT_REDACT_KEYS, ...(config.redactKeys ?? [])];
  const matchPatterns = config.matchPatterns ?? true;
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return scrubString(current, matchPatterns);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") return Number.isFinite(current) ? current : String(current);
    if (typeof current === "bigint" || typeof current === "undefined") return String(current);
    if (typeof current === "symbol") return current.description ?? "Symbol";
    if (typeof current === "function") return `[Function ${current.name || "anonymous"}]`;
    if (typeof current !== "object") return String(current);

    if (depth >= maxDepth) return "[MAX_DEPTH]";
    if (ancestors.has(current)) return "[CIRCULAR]";
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      return {
        name: scrubString(current.name, matchPatterns),
        message: scrubString(current.message, matchPatterns),
      };
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item) => visit(item, depth + 1));
      }

      const output: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(current)) {
        output[key] = shouldRedactKey(key, redactKeys) ? REDACTED : visit(child, depth + 1);
      }
      return output;
    } catch {
      try {
        return scrubString(String(current), matchPatterns);
      } catch {
        return "[UNSERIALIZABLE]";
      }
    } finally {
      ancestors.delete(current);
    }
  };

  return visit(value, 0);
}
