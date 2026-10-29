import type { ReportContext, Reporter } from "../shared/types.js";

export type { ReportContext, Reporter } from "../shared/types.js";

export interface NextRequestLike {
  method?: string;
  url?: string;
  path?: string;
  nextUrl?: {
    pathname?: string;
  };
}

function pathnameOf(request: NextRequestLike): string {
  if (request.nextUrl?.pathname) return request.nextUrl.pathname;
  if (request.path) return request.path.split("?")[0] || "unknown";
  if (!request.url) return "unknown";
  try {
    // NextApiRequest.url (Pages Router) is relative ("/api/orders?x=1"); a base is
    // required so relative URLs do not throw and fall through to "unknown".
    return new URL(request.url, "http://localhost").pathname;
  } catch {
    return "unknown";
  }
}

function nextContext(context: ReportContext | undefined): ReportContext {
  return {
    ...context,
    tags: {
      ...context?.tags,
      framework: "next",
    },
  };
}

export function captureRequestError(
  reporter: Reporter,
  error: unknown,
  request: NextRequestLike,
  context?: ReportContext,
): string | undefined {
  const next = nextContext(context);
  next.tags = {
    ...next.tags,
    http_method: request.method ?? "unknown",
    http_route: pathnameOf(request),
  };
  return reporter.reportError(error, next);
}

export function reportNextError(
  reporter: Reporter,
  error: unknown,
  context?: ReportContext,
): string | undefined {
  return reporter.reportError(error, nextContext(context));
}

export function withRouteErrorCapture<
  TRequest extends NextRequestLike,
  TRest extends unknown[],
  TResult,
>(
  reporter: Reporter,
  handler: (request: TRequest, ...rest: TRest) => TResult | Promise<TResult>,
): (request: TRequest, ...rest: TRest) => Promise<TResult> {
  return async (request, ...rest) => {
    try {
      return await handler(request, ...rest);
    } catch (error) {
      captureRequestError(reporter, error, request);
      throw error;
    }
  };
}
