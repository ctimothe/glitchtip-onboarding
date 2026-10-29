import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { colors, fonts, motion, radii, severityColor, windowChrome } from "./tokens";

describe("tokens", () => {
  it("carries the spec palette verbatim", () => {
    expect(colors).toMatchObject({
      void: "#05070D",
      abyss: "#0A0F1E",
      error: "#F04452",
      warning: "#F5A524",
      info: "#3B82F6",
      delivered: "#10B981",
      ink: "#F4F6FB",
      muted: "#9AA4B2",
      faint: "#5B6472",
    });
  });

  it("maps every severity to a brand color", () => {
    expect(severityColor).toEqual({ error: colors.error, warning: colors.warning, info: colors.info });
    expect(severityColor.error).not.toBe(severityColor.warning);
  });

  it("mirrors every color into the Tailwind @theme block", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").toLowerCase();
    for (const [name, hex] of Object.entries(colors)) {
      expect(css).toContain(`--color-${name}`);
      expect(css).toContain(hex.toLowerCase());
    }
    expect(css).toContain("--font-display");
    expect(css).toContain("--font-body");
    expect(css).toContain("--font-mono");
  });

  it("keeps DOM motion inside the spec budget", () => {
    expect(motion.revealMs[0]).toBeGreaterThanOrEqual(160);
    expect(motion.revealMs[1]).toBeLessThanOrEqual(240);
    expect(motion.ease).toBe("easeOut");
  });

  it("exposes display, body, and mono font stacks", () => {
    expect(fonts.display).toMatch(/Space Grotesk/);
    expect(fonts.body).toMatch(/Inter/);
    expect(fonts.mono).toMatch(/JetBrains Mono/);
  });

  it("exposes mac window chrome constants outside the Tailwind palette", () => {
    expect(windowChrome).toEqual({ close: "#FF5F57", minimize: "#FEBC2E", zoom: "#28C840" });
  });
});
