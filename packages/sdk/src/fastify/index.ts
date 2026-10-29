import type { onErrorHookHandler } from "fastify";

import type { ReportContext, Reporter } from "../shared/types.js";

export type { Reporter } from "../shared/types.js";

function statusOf(replyStatus: number, error: { statusCode?: number }): number {
  if (replyStatus >= 400) return replyStatus;
  return error.statusCode ?? 500;
}

export function createFastifyErrorHook(reporter: Reporter): onErrorHookHandler {
  return (request, reply, error, done) => {
    const legacyRoute = (request as typeof request & { routerPath?: string }).routerPath;
    const context: ReportContext = {
      tags: {
        framework: "fastify",
        http_method: request.method,
        http_route: request.routeOptions?.url ?? legacyRoute ?? "unknown",
        http_status: statusOf(reply.statusCode, error),
      },
    };
    if (request.id) context.requestId = request.id;
    reporter.reportError(error, context);
    done();
  };
}
