import { browserConfigFromEnv, createBrowserReporter } from "@glitchtip-onboarding/sdk/browser";
import { createNodeReporter, nodeConfigFromEnv } from "@glitchtip-onboarding/sdk/node";

const reporter = createNodeReporter({
  dsn: undefined,
  project: "fixture",
  environment: "test",
});

reporter.reportError(new Error("fixture"));
reporter.reportWarning("fixture warning");
reporter.reportInfo("fixture info");
void reporter.flush(10);

createBrowserReporter({
  dsn: undefined,
  project: "fixture-browser",
  environment: "test",
});

nodeConfigFromEnv({ GLITCHTIP_PROJECT: "fixture", APP_ENV: "test" });
browserConfigFromEnv(
  { VITE_GLITCHTIP_DSN: "fixture-dsn" },
  { project: "fixture-browser", environment: "test" },
);
