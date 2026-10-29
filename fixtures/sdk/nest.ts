import type { INestApplication } from "@nestjs/common";
import { createGlitchTipExceptionFilter } from "@glitchtip-onboarding/sdk/nest";
import type { Reporter } from "@glitchtip-onboarding/sdk/node";

declare const app: INestApplication;
declare const reporter: Reporter;

app.useGlobalFilters(createGlitchTipExceptionFilter(reporter, app.getHttpAdapter()));
