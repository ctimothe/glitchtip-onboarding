import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-explicit-any -- declaration merging, same shape as the package's own vitest entry */
declare module "vitest" {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}
