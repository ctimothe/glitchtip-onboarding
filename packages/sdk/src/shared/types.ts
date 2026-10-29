export type Severity = "error" | "warning" | "info";

export type PrimitiveTag = string | number | boolean;

export interface ScrubConfig {
  maxDepth?: number;
  redactKeys?: string[];
  matchPatterns?: boolean;
}

export interface ReportContext {
  tags?: Record<string, PrimitiveTag>;
  extra?: Record<string, unknown>;
  user?: {
    id: string;
    role?: string;
  };
  requestId?: string;
  fingerprint?: string[];
}

export interface ReporterConfig {
  dsn?: string;
  project: string;
  environment: string;
  release?: string;
  enabled?: boolean;
  debug?: boolean;
  scrub?: ScrubConfig;
  beforeSend?: (event: unknown) => unknown | null;
}

export interface Reporter {
  reportError(error: unknown, context?: ReportContext): string | undefined;
  reportWarning(message: string, context?: ReportContext): string | undefined;
  reportInfo(message: string, context?: ReportContext): string | undefined;
  flush(timeoutMs?: number): Promise<boolean>;
}

export interface CapturePayload {
  level: Severity;
  tags: Record<string, PrimitiveTag>;
  extra?: Record<string, unknown>;
  user?: {
    id: string;
    role?: string;
  };
  fingerprint?: string[];
}

export interface CaptureBackend {
  captureException(error: Error, payload: CapturePayload): string | undefined;
  captureMessage(message: string, payload: CapturePayload): string | undefined;
  flush(timeoutMs: number): Promise<boolean>;
}
