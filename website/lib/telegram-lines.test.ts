import { describe, expect, it } from "vitest";
import { telegramHeader } from "./telegram-lines";

describe("telegramHeader", () => {
  it("matches the relay format.js header shape", () => {
    // Mirrors TEMPLATE + projectLabel + impact in assets/relay/format.js lines 190-201.
    expect(telegramHeader("billing-api", "production", "error", 3)).toBe("🚨 <b>[billing-api·production]</b> · 3× · Error");
    expect(telegramHeader("billing-api", "production", "warning", null)).toBe("⚠️ <b>[billing-api·production]</b> · Warning");
    expect(telegramHeader("billing-api", "production", "info", 1)).toBe("ℹ️ <b>[billing-api·production]</b> · 1× · Info");
  });
});
