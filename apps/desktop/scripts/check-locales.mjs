// Locale completeness check: every dictionary must carry exactly the keys of
// en.json (the source language) and the same {placeholders}.
//   npm run check:locales
// Exit code 1 on any difference, so it can guard a release.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'src', 'locales');

// Switcher order, same as LOCALES in src/i18n.ts.
const LOCALES = ['en', 'ru', 'es', 'pt-BR', 'de', 'fr', 'it', 'tr', 'pl', 'zh-CN'];

const read = (locale) => JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8'));
const placeholders = (value) =>
  [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');

const source = read('en');
const sourceKeys = Object.keys(source);
let problems = 0;

console.log(`source: en.json, ${sourceKeys.length} keys\n`);
for (const locale of LOCALES) {
  const dict = read(locale);
  const keys = Object.keys(dict);
  const missing = sourceKeys.filter((key) => !(key in dict));
  const extra = keys.filter((key) => !(key in source));
  const badVars = sourceKeys.filter(
    (key) => key in dict && placeholders(dict[key]) !== placeholders(source[key]),
  );
  const untranslated = locale === 'en'
    ? []
    : sourceKeys.filter((key) => key in dict && dict[key] === source[key] && placeholders(source[key]) === '');

  const diffs = missing.length + extra.length + badVars.length;
  problems += diffs;
  console.log(
    `${locale.padEnd(6)} ${String(keys.length).padStart(3)} keys  ` +
      `missing ${missing.length}  extra ${extra.length}  ` +
      `placeholder mismatch ${badVars.length}  ` +
      `same as English ${untranslated.length}  ` +
      (diffs === 0 ? 'OK' : 'MISMATCH'),
  );
  for (const key of missing) console.log(`  - missing: ${key}`);
  for (const key of extra) console.log(`  + extra: ${key}`);
  for (const key of badVars) console.log(`  ~ placeholders: ${key}`);
  if (untranslated.length > 0) {
    // Not an error: "URL", "#", "↓" and similar are the same in every language.
    console.log(`  = untranslated: ${untranslated.join(', ')}`);
  }
}

if (problems > 0) {
  console.error(`\n${problems} key problem(s) found`);
  process.exit(1);
}
console.log('\nall locales complete: 0 key differences');
