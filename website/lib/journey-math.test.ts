import { describe, expect, it } from "vitest";
import { BEAT_COUNT, beatAt, scrollToJourneyT } from "./journey-math";

describe("journey math", () => {
  it("maps scroll extremes to journey extremes", () => {
    expect(scrollToJourneyT(0, 1000)).toBe(0);
    expect(scrollToJourneyT(1000, 1000)).toBe(1);
    expect(scrollToJourneyT(500, 1000)).toBe(0.5);
  });

  it("clamps overscroll and zero-height pages", () => {
    expect(scrollToJourneyT(-50, 1000)).toBe(0);
    expect(scrollToJourneyT(1500, 1000)).toBe(1);
    expect(scrollToJourneyT(0, 0)).toBe(0);
  });

  it("resolves the active beat", () => {
    expect(BEAT_COUNT).toBe(7);
    expect(beatAt(0)).toBe(0);
    expect(beatAt(0.5)).toBe(3);
    expect(beatAt(1)).toBe(6);
  });
});
