import {
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
  type HttpServer,
} from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";

import type { ReportContext, Reporter } from "../shared/types.js";

export type { Reporter } from "../shared/types.js";

interface NestRequestLike {
  id?: unknown;
  method?: unknown;
  route?: { path?: unknown };
}

function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  if (exception && typeof exception === "object") {
    const status = (exception as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return 500;
}

export function createGlitchTipExceptionFilter(
  reporter: Reporter,
  applicationRef: HttpServer,
): ExceptionFilter {
  return new (class GlitchTipExceptionFilter extends BaseExceptionFilter {
    constructor() {
      super(applicationRef);
    }

    override catch(exception: unknown, host: ArgumentsHost): void {
      const request = host.switchToHttp().getRequest<NestRequestLike>();
      const context: ReportContext = {
        tags: {
          framework: "nest",
          http_method: typeof request.method === "string" ? request.method : "unknown",
          http_route:
            typeof request.route?.path === "string" ? request.route.path : "unknown",
          http_status: statusOf(exception),
        },
      };
      if (typeof request.id === "string") context.requestId = request.id;
      reporter.reportError(exception, context);
      super.catch(exception, host);
    }
  })();
}
