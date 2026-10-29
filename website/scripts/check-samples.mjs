// Asserts every SDK symbol quoted on the landing page exists in the built SDK.
// Run the SDK build first: `npm run build` at the repo root.
import { strict as assert } from "node:assert";

const CANDIDATES = (base) => [`${base}.js`, `${base}.cjs`];

async function loadEntry(base) {
  for (const file of CANDIDATES(base)) {
    try {
      // new URL() already yields a file: URL — no pathToFileURL needed.
      return await import(new URL(`../../packages/sdk/dist/${file}`, import.meta.url).href);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  console.error("BUILD THE SDK FIRST: `npm run build` at the repo root, then re-run.");
  process.exit(2);
}

const api = {};
for (const [base, names] of Object.entries({
  node: ["createNodeReporter", "nodeConfigFromEnv", "installProcessErrorHandlers"],
  express: ["createExpressErrorMiddleware"],
  fastify: ["createFastifyErrorHook"],
  nest: ["createGlitchTipExceptionFilter"],
  react: ["ObservabilityProvider", "ObservabilityErrorBoundary"],
  next: ["withRouteErrorCapture", "reportNextError"],
})) {
  const mod = await loadEntry(base);
  for (const name of names) {
    assert.ok(mod[name] !== undefined, `${base} must export ${name}`);
  }
  api[base] = mod;
}

const telemetry = api.node.createNodeReporter({ project: "samples-check" });
for (const method of ["reportError", "reportWarning", "reportInfo", "flush"]) {
  assert.equal(typeof telemetry[method], "function", `reporter must have ${method}()`);
}

console.log("samples OK");
