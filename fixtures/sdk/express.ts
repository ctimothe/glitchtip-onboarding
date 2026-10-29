import type { Express } from "express";
import { createExpressErrorMiddleware } from "@glitchtip-onboarding/sdk/express";
import type { Reporter } from "@glitchtip-onboarding/sdk/node";

declare const app: Express;
declare const reporter: Reporter;

app.use(createExpressErrorMiddleware(reporter));
