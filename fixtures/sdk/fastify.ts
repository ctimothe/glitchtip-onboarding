import type { FastifyInstance } from "fastify";
import { createFastifyErrorHook } from "@glitchtip-onboarding/sdk/fastify";
import type { Reporter } from "@glitchtip-onboarding/sdk/node";

declare const app: FastifyInstance;
declare const reporter: Reporter;

app.addHook("onError", createFastifyErrorHook(reporter));
