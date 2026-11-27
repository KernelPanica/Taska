import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@yourtask/contracts";
import { en } from "./en";
import { ru, type MessageKey } from "./ru";

export type { MessageKey };
export const dictionaries: Record<Locale, Record<MessageKey, string>> = { ru, en };
const STORAGE_KEY = "yourtask.locale";

function readStored(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

/** До входа: сохранённый выбор, затем язык браузера. После входа язык берётся из профиля. */
export function initialLocale(): Locale {
  const stored = readStored();
  if (stored) return stored;
  const browser = typeof navigator === "undefined" ? "" : navigator.language.slice(0, 2);
  return isLocale(browser) ? browser : DEFAULT_LOCALE;
}

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>) {
  let text = dictionaries[locale][key] ?? ru[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

interface I18n {
  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: MessageKey, params?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children, locale: forced }: { children: ReactNode; locale?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => forced ?? initialLocale());
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Хранилище может быть недоступно (приватный режим) — язык всё равно применится.
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t: (key, params) => translate(locale, key, params) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
