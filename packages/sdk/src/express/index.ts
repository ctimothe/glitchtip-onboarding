import type { ErrorRequestHandler, Request } from "express";

import type { ReportContext, Reporter } from "../shared/types.js";

export type { Reporter } from "../shared/types.js";

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.status === "number") return candidate.status;
  return undefined;
}

function requestId(request: Request): string | undefined {
  const id = (request as Request & { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

export function createExpressErrorMiddleware(reporter: Reporter): ErrorRequestHandler {
  return (error, request, response, next) => {
    const status =
      errorStatus(error) ?? (response.statusCode >= 400 ? response.statusCode : 500);
    const context: ReportContext = {
      tags: {
        framework: "express",
        http_method: request.method,
        http_route: String(request.route?.path ?? "unknown"),
        http_status: status,
      },
    };
    const id = requestId(request);
    if (id) context.requestId = id;

    reporter.reportError(error, context);
    next(error);
  };
}
