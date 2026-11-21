// Micro i18n: flat key -> string dictionaries, no library.
// English is the source language and the reference key set: a key that is
// missing from the current locale falls back to English, and a key that is
// missing everywhere falls back to the key itself, so backend-provided prose
// (e.g. update changelog lines) passes through.
//
// `npm run check:locales` compares every dictionary with en.json.

import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import pl from './locales/pl.json';
import ptBR from './locales/pt-BR.json';
import ru from './locales/ru.json';
import tr from './locales/tr.json';
import zhCN from './locales/zh-CN.json';

export type Locale = 'en' | 'ru' | 'es' | 'pt-BR' | 'de' | 'fr' | 'it' | 'tr' | 'pl' | 'zh-CN';

/** Every shipped locale, in switcher order. */
export const LOCALES: Locale[] = ['en', 'ru', 'es', 'pt-BR', 'de', 'fr', 'it', 'tr', 'pl', 'zh-CN'];

/** Names written in the language itself: the list is readable from any locale. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  tr: 'Türkçe',
  pl: 'Polski',
  'zh-CN': '简体中文',
};

const DICTS: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  ru: ru as Record<string, string>,
  es: es as Record<string, string>,
  'pt-BR': ptBR as Record<string, string>,
  de: de as Record<string, string>,
  fr: fr as Record<string, string>,
  it: it as Record<string, string>,
  tr: tr as Record<string, string>,
  pl: pl as Record<string, string>,
  'zh-CN': zhCN as Record<string, string>,
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as string[]).includes(value);
}

let current: Locale = 'en';
/** Fallback warnings are per key, so a polled table does not flood the console. */
const warned = new Set<string>();

export function setLocale(locale: Locale): void {
  current = isLocale(locale) ? locale : 'en';
  document.documentElement.lang = current;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let template = DICTS[current][key];
  if (template === undefined) {
    template = DICTS.en[key];
    if (template === undefined) return key;
    // Missing translations are an authoring bug, not a runtime condition:
    // warn in the dev server only, the release build stays silent.
    if (import.meta.env.DEV && current !== 'en' && !warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] ${current} has no "${key}", using English`);
    }
  }
  if (!vars) return template;
  return Object.entries(vars).reduce(
    (acc, [name, value]) => acc.split(`{${name}}`).join(String(value)),
    template,
  );
}
