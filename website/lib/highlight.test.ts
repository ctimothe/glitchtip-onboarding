import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

describe("highlight", () => {
  it("returns themed HTML containing the escaped source", async () => {
    const html = await highlight("const a = 'x<y';", "ts");
    expect(html).toContain("shiki");
    expect(html).toContain("github-dark");
    // shiki v4 escapes `<` as `&#x3C;` (not `&lt;`) — assert the escaped form it emits.
    expect(html).toContain("x&#x3C;y");
    expect(html).not.toContain("x<y");
  });
});
