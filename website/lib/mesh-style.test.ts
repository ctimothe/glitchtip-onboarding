import { describe, expect, it } from "vitest";
import { beatStyle } from "./mesh-style";

describe("beatStyle", () => {
  it("covers all 7 beats with in-range props", () => {
    for (let beat = 0; beat < 7; beat++) {
      const style = beatStyle(beat);
      expect(style.speed).toBeGreaterThan(0);
      expect(style.speed).toBeLessThanOrEqual(1);
      expect(style.swirl).toBeGreaterThanOrEqual(0);
      expect(style.swirl).toBeLessThanOrEqual(1);
      expect(style.distortion).toBe(0.8);
      expect(style.grainOverlay).toBe(0.12);
    }
  });

  it("rises toward the relay beats and settles at the close", () => {
    expect(beatStyle(5).speed).toBeGreaterThan(beatStyle(0).speed);
    expect(beatStyle(5).swirl).toBeGreaterThan(beatStyle(0).swirl);
    expect(beatStyle(6).speed).toBe(beatStyle(3).speed);
    expect(beatStyle(6).swirl).toBe(beatStyle(3).swirl);
  });

  it("clamps out-of-range beats", () => {
    expect(beatStyle(-1)).toEqual(beatStyle(0));
    expect(beatStyle(99)).toEqual(beatStyle(6));
  });
});
