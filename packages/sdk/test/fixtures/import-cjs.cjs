const browser = require("@glitchtip-onboarding/sdk/browser");
const express = require("@glitchtip-onboarding/sdk/express");
const fastify = require("@glitchtip-onboarding/sdk/fastify");
const nest = require("@glitchtip-onboarding/sdk/nest");
const next = require("@glitchtip-onboarding/sdk/next");
const node = require("@glitchtip-onboarding/sdk/node");
const react = require("@glitchtip-onboarding/sdk/react");

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
  if (typeof entry[name] !== "function") throw new Error(`missing CommonJS export: ${name}`);
}
