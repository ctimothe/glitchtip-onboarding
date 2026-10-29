import * as browser from "@glitchtip-onboarding/sdk/browser";
import * as express from "@glitchtip-onboarding/sdk/express";
import * as fastify from "@glitchtip-onboarding/sdk/fastify";
import * as nest from "@glitchtip-onboarding/sdk/nest";
import * as next from "@glitchtip-onboarding/sdk/next";
import * as node from "@glitchtip-onboarding/sdk/node";
import * as react from "@glitchtip-onboarding/sdk/react";

const exportsToCheck = [
  [node, "createNodeReporter"],
  [node, "nodeConfigFromEnv"],
  [browser, "createBrowserReporter"],
  [browser, "browserConfigFromEnv"],
  [react, "ObservabilityErrorBoundary"],
  [next, "captureRequestError"],
  [express, "createExpressErrorMiddleware"],
  [nest, "createGlitchTipExceptionFilter"],
  [fastify, "createFastifyErrorHook"],
];

for (const [entry, name] of exportsToCheck) {
  if (typeof entry[name] !== "function") throw new Error(`missing ESM export: ${name}`);
}
