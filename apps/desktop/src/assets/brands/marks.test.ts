// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("./", import.meta.url);
const README = readFileSync(new URL("README.md", DIR), "utf8");

describe("brand marks", () => {
  for (const name of ["glitchtip", "telegram", "openai", "anthropic"]) {
    it(`${name}.svg is the recorded official file`, () => {
      const file = readFileSync(new URL(`${name}.svg`, DIR));
      const row = README.split("\n").find((line) => line.startsWith(`| ${name}.svg |`));
      const recorded = row?.match(/`([0-9a-f]{64})` \|$/)?.[1];
      expect(recorded).toBeDefined();
      expect(createHash("sha256").update(file).digest("hex")).toBe(recorded);
      expect(file.toString("utf8")).not.toMatch(/<script|<foreignObject|<image|\bon[a-z]+=|href=/i);
    });
  }
});
