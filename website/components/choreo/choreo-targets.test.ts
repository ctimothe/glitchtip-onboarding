import { describe, expect, it } from "vitest";
import { STAGES, railLabel } from "./choreo-targets";

describe("choreo targets", () => {
  it("covers intro + 6 beats with stable ids", () => {
    expect(STAGES.map((s) => s.id)).toEqual(["top", "beat-1", "beat-2", "beat-3", "beat-4", "beat-5", "beat-6"]);
  });

  it("labels every stage", () => {
    for (const stage of STAGES) expect(stage.label.length).toBeGreaterThan(0);
    expect(railLabel(0)).toBe("Intro");
    expect(railLabel(5)).toBe("Relay");
  });

  it("clamps out-of-range beats", () => {
    expect(railLabel(-1)).toBe("Intro");
    expect(railLabel(99)).toBe("Human");
  });
});
