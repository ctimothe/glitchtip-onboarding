import { defineConfig } from "tsup";

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  entry: {
    node: "src/node/index.ts",
    browser: "src/browser/index.ts",
    react: "src/react/index.tsx",
    next: "src/next/index.ts",
    express: "src/express/index.ts",
    nest: "src/nest/index.ts",
    fastify: "src/fastify/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    "@sentry/browser",
    "@sentry/node",
    "@nestjs/common",
    "@nestjs/core",
    "express",
    "fastify",
    "react",
    "react/jsx-runtime",
  ],
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
});
