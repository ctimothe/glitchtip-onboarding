import { describe, expect, it } from "vitest";
import { shouldUseWebGL, type CapabilityInput } from "./capabilities";

const capable: CapabilityInput = {
  prefersReducedMotion: false,
  isMobileUA: false,
  webglAvailable: true,
  deviceMemory: 8,
  hardwareConcurrency: 8,
};

describe("shouldUseWebGL", () => {
  it("allows a capable desktop", () => {
    expect(shouldUseWebGL(capable)).toBe(true);
  });

  it.each([
    ["reduced motion", { ...capable, prefersReducedMotion: true }],
    ["mobile UA", { ...capable, isMobileUA: true }],
    ["no WebGL", { ...capable, webglAvailable: false }],
    ["2 GB RAM", { ...capable, deviceMemory: 2 }],
    ["2 cores", { ...capable, hardwareConcurrency: 2 }],
  ])("refuses %s", (_label, input) => {
    expect(shouldUseWebGL(input)).toBe(false);
  });

  it("allows unknown memory figures (desktop without deviceMemory API, e.g. Safari)", () => {
    expect(shouldUseWebGL({ ...capable, deviceMemory: undefined, hardwareConcurrency: undefined })).toBe(true);
  });
});
