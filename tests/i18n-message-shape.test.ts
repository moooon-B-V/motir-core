import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareMessageShape } from '../scripts/i18n/messageShape';
import { flattenCatalogue } from '../scripts/i18n/sourceRecord';
import { locales as appLocales } from '../lib/i18n/locales';

// MOTIR-7745 — every translated string keeps the ICU shape of its English
// source: the same arguments, of the same kind, the same select options, plural
// branches valid for the target language, and the same rich-text tags nested
// the same way. `pnpm i18n:merge` refuses a batch entry that breaks one; this is
// the standing gate over what is already committed, so a hand edit to a
// catalogue meets the same check.
//
// The locales are found by LISTING `messages/`, never by naming them, so a new
// catalogue is checked the moment it lands. A plural branch is judged against
// the TARGET locale's CLDR categories, so Japanese with only `other` and Polish
// with `few` / `many` both pass when they are right for the language.

const ROOT = process.cwd();
const MESSAGES = join(ROOT, 'messages');

/** Every catalogue except the English source, by directory listing. */
function targetLocales(): string[] {
  return readdirSync(MESSAGES)
    .filter((f) => /^[a-z]{2,3}(-[A-Za-z0-9]+)?\.json$/.test(f) && f !== 'en.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

function load(locale: string) {
  return flattenCatalogue(JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8')));
}

/**
 * Committed strings that break the shape today, keyed `<locale>:<key>`. Every
 * row is a zh string written before this gate existed — almost all of them a
 * plural flattened to a bare `{count}`, which Chinese reads fine but which
 * drops the branch structure the source carries. MOTIR-7781 corrects zh's
 * drift and shrinks this list. Asserted TIGHT in both directions: an unlisted
 * violation fails, and a listed row that no longer violates fails too, so the
 * list can only shrink.
 */
const KNOWN_SHAPE_DEBT: Record<string, string> = {};

function violations(): Map<string, string> {
  const en = load('en');
  const found = new Map<string, string>();
  for (const locale of targetLocales()) {
    const target = load(locale);
    for (const [key, source] of en) {
      const translated = target.get(key);
      if (translated === undefined) continue;
      const v = compareMessageShape(source, translated, locale);
      if (v.length) found.set(`${locale}:${key}`, v.map((x) => x.detail).join('; '));
    }
  }
  return found;
}

describe('i18n message shape (MOTIR-7745)', () => {
  it('checks every catalogue in messages/, zh among them', () => {
    const locales = targetLocales();
    expect(locales).toContain('zh');
    expect(locales).not.toContain('en');
  });

  it('the listing reaches every locale the app speaks (MOTIR-7760)', () => {
    // So a green run is a claim about all ten translated catalogues, not about
    // whichever happen to sit in the directory.
    expect(targetLocales()).toEqual(appLocales.filter((l) => l !== 'en').sort());
  });

  it('every translated string keeps its English source shape, apart from the listed debt', () => {
    const found = violations();
    const unlisted = [...found].filter(([k]) => !(k in KNOWN_SHAPE_DEBT));
    expect(unlisted.map(([k, d]) => `${k}: ${d}`)).toEqual([]);
  });

  it('every KNOWN_SHAPE_DEBT row still violates (the list only shrinks)', () => {
    const found = violations();
    const fixed = Object.keys(KNOWN_SHAPE_DEBT).filter((k) => !found.has(k));
    expect(fixed).toEqual([]);
  });

  it('the scan is not vacuous: a dropped argument is caught', () => {
    expect(compareMessageShape('Hi {name}', 'Hallo', 'de').length).toBeGreaterThan(0);
  });
});
