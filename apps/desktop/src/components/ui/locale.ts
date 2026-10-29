import { createContext, useContext } from "react";

import { t, type Locale, type TranslationKey } from "../../i18n";

/** The app shell provides the workspace language; primitives have no locale prop. */
export const UiLocale = createContext<Locale | null>(null);

// Outside a provider (tests, isolated renders) follow the document language, else English.
function documentLocale(): Locale {
  const lang = typeof document === "undefined" ? "" : document.documentElement.lang;
  return lang === "uz" || lang === "ru" ? lang : "en";
}

export function useUi(): (key: TranslationKey) => string {
  const locale = useContext(UiLocale) ?? documentLocale();
  return (key) => t(locale, key);
}
