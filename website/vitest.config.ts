import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test-only config (no runtime deps): Next compiles `jsx: preserve` itself,
// but vitest/esbuild honors tsconfig and would emit classic `React.createElement`
// calls with no React in scope. Force the automatic runtime for tests and mirror
// the tsconfig `@/*` path alias, which vitest does not resolve on its own.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },
});
