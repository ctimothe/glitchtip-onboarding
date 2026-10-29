import "@testing-library/jest-dom/vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

// Registered explicitly on this file's `expect`: the package's own vitest entry
// can bind to a second vitest instance when node_modules is a symlinked install.
expect.extend(matchers);

// Every component test starts from an empty document.
afterEach(() => {
  cleanup();
});
