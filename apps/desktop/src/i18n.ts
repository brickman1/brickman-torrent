// Micro i18n: flat key -> string dictionaries, no library.
// English is the source language; unknown keys fall back to the key itself,
// so backend-provided prose (e.g. update changelog lines) passes through.

import en from './locales/en.json';
import ru from './locales/ru.json';

export type Locale = 'en' | 'ru';

const DICTS: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  ru: ru as Record<string, string>,
};

export const LOCALES: Locale[] = ['en', 'ru'];

let current: Locale = 'en';

export function setLocale(locale: Locale): void {
  current = DICTS[locale] ? locale : 'en';
  document.documentElement.lang = current;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const template = DICTS[current][key] ?? DICTS.en[key] ?? key;
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    template,
  );
}
