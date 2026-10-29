/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Screen tests drive a jsdom UI step by step; on a loaded machine (the
    // full gate runs the SDK pack beside them) 5 s is not enough. Agents run
    // two workers so their runs do not starve everything else on the Mac.
    testTimeout: 15_000,
    maxWorkers: process.env.CLAUDECODE ? 2 : undefined,
    // The Tauri build copies bundled resources (and their tests) under src-tauri/target.
    exclude: ["**/node_modules/**", "**/src-tauri/target/**"],
  },
  // Emit every asset as a file: the app's CSP (tauri.conf.json) allows images
  // from 'self' only, so inlined data: URIs would be blocked in the bundle.
  build: { assetsInlineLimit: 0 },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
