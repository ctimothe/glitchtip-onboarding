// Locale lookup + interpolation. en.ts is the literal-keyed source of
// truth; ru.ts and uz.ts are typed `Record<keyof typeof en, string>`, so
// TypeScript already guarantees every locale carries the same key set.
// index.test.ts additionally checks, at runtime, that every translation
// carries the same `{placeholder}` set as the matching English string.

import { en } from "./en";
import { ru } from "./ru";
import { uz } from "./uz";

export type Locale = "uz" | "ru" | "en";
export type TranslationKey = keyof typeof en;

const LOCALES: Record<Locale, Record<TranslationKey, string>> = { en, ru, uz };

const PLACEHOLDER_RE = /\{(\w+)\}/g;

/**
 * Look up `key` in `locale` and interpolate any `{name}` placeholders from
 * `values`. There is no silent fallback to another language: a placeholder
 * with no matching entry in `values` throws.
 */
export function t(
  locale: Locale,
  key: TranslationKey,
  values?: Record<string, string | number>,
): string {
  const template = LOCALES[locale][key];
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = values?.[name];
    if (value === undefined) {
      throw new Error(`Missing interpolation value "${name}" for key "${String(key)}"`);
    }
    return String(value);
  });
}

export { en, ru, uz };
