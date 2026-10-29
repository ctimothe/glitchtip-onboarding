// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scrubFixture } from "./content";
// Direct source import: the page fixture must obey the real scrub rules.
import { scrubValue } from "../../packages/sdk/src/shared/scrub";

describe("scrub fixture truth", () => {
  it("matches scrubValue output exactly", () => {
    expect(scrubValue(scrubFixture.input)).toEqual({
      user: { email: "[REDACTED]" },
      extra: { api_key: "[REDACTED]", attempt: 2 },
    });
  });

  it("matches the displayed after-text", () => {
    expect(JSON.parse(scrubFixture.after)).toEqual(scrubValue(scrubFixture.input));
  });
});
