import { describe, expect, it } from "vitest";

import { en } from "./en";
import { ru } from "./ru";
import { uz } from "./uz";
import { t } from "./index";

function placeholderNames(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe("locale", () => {
  describe("key parity", () => {
    it("ru declares exactly the same keys as en", () => {
      expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    });

    it("uz declares exactly the same keys as en", () => {
      expect(Object.keys(uz).sort()).toEqual(Object.keys(en).sort());
    });
  });

  describe("placeholder parity", () => {
    it("every ru translation carries the same {placeholder} set as its en original", () => {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(placeholderNames(ru[key])).toEqual(placeholderNames(en[key]));
      }
    });

    it("every uz translation carries the same {placeholder} set as its en original", () => {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(placeholderNames(uz[key])).toEqual(placeholderNames(en[key]));
      }
    });
  });

  describe("app name", () => {
    it("is never translated", () => {
      expect(en.appName).toBe("GlitchTip Companion");
      expect(ru.appName).toBe("GlitchTip Companion");
      expect(uz.appName).toBe("GlitchTip Companion");
    });
  });

  describe("t()", () => {
    it("looks up a plain key with no placeholders", () => {
      expect(t("en", "action.save")).toBe("Save");
      expect(t("ru", "action.save")).toBe("Сохранить");
      expect(t("uz", "action.save")).toBe("Saqlash");
    });

    it("interpolates {name}-style placeholders from values", () => {
      expect(
        t("en", "alertPreset.balanced.threshold", { quantity: 3, minutes: 15 }),
      ).toBe("3 events in 15 minutes");
      expect(
        t("uz", "alertPreset.quiet.threshold", { quantity: 10, minutes: 60 }),
      ).toBe("60 daqiqada 10 hodisa");
    });

    it("throws when an interpolation value is missing, without falling back to another language", () => {
      expect(() => t("en", "alertPreset.balanced.threshold", { quantity: 3 })).toThrow(
        /minutes/,
      );
      expect(() => t("en", "alertPreset.balanced.threshold", {})).toThrow();
      expect(() => t("en", "alertPreset.balanced.threshold")).toThrow();
    });
  });
});
