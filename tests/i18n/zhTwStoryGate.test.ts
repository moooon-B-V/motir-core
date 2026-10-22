import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FONT_SET_LOCALES,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  LOCALE_FONT_SET,
  fontSetMemberVar,
  resolveFontSet,
  type FontSetMember,
} from '@motir/design-system';
import { matchAcceptLanguage, matchAcceptLanguageAmong } from '@/lib/i18n/acceptLanguage';
import { locales } from '@/lib/i18n/locales';

// Story MOTIR-8937 · MOTIR-9242 — the motir-core half of the story's integration
// gate. Each of the three cards (the zh-tw glossary, the zh-Hant font set, the
// Traditional Accept-Language rule) tests its own module; this file tests only
// the SEAMS between them and the contracts motir-marketing reads from core. No
// browser, no database: matcher, registry, resolver and files on disk.

const ROOT = process.cwd();
const readJson = (path: string) => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as unknown;

interface GlossaryTerm {
  translation: string;
  doNotTranslate?: boolean;
  banned?: string[];
}
interface Glossary {
  locale: string;
  terms: Record<string, GlossaryTerm>;
}

const ZH_TW = readJson('messages/glossary/zh-tw.json') as Glossary;
const ZH = readJson('messages/glossary/zh.json') as Glossary;

/** The two shapes of the locale set: core's own today, and motir.co's (zh-tw after zh). */
const WITHOUT_ZH_TW = [...locales] as string[];
const WITH_ZH_TW = WITHOUT_ZH_TW.flatMap((l) => (l === 'zh' ? ['zh', 'zh-tw'] : [l]));

const TRADITIONAL = ['zh-TW', 'zh-Hant', 'zh-HK', 'zh-MO', 'zh-Hant-TW'];
const SIMPLIFIED = ['zh', 'zh-CN', 'zh-Hans'];

/**
 * motir-marketing's `messages/en.json` `nav.productItems.*.name` values, copied
 * by hand: core has no such keys, and marketing's `productItemNames` sweep
 * requires each zh-tw catalogue name to equal the glossary translation keyed by
 * exactly these strings.
 */
const PRODUCT_NAMES = [
  'Motir AI Planner',
  'Motir Project Management',
  'Motir Project Manager',
  'Motir AI Debugging',
  'Motir MCP',
  'Motir CLI',
  'Motir Claude Code connector',
  'Motir Claude Code plugin',
  'Motir Agent Fleet',
  'Motir Agent Hosting',
  'Motir Sandbox',
];

describe('Accept-Language → locale, over both shapes of the locale set', () => {
  it('leaves core’s own app unchanged: zh-TW still reads as zh', () => {
    expect(locales).not.toContain('zh-tw');
    expect(matchAcceptLanguage('zh-TW')).toBe('zh');
  });

  it.each(TRADITIONAL)('%s reads as zh without zh-tw, and as zh-tw with it', (header) => {
    expect(matchAcceptLanguageAmong(header, WITHOUT_ZH_TW)).toBe('zh');
    expect(matchAcceptLanguageAmong(header, WITH_ZH_TW)).toBe('zh-tw');
  });

  it.each(SIMPLIFIED)('%s reads as zh with zh-tw in the set', (header) => {
    expect(matchAcceptLanguageAmong(header, WITH_ZH_TW)).toBe('zh');
  });
});

describe('locale → font set → <html lang> → font set', () => {
  it.each(TRADITIONAL)(
    'a %s reader lands on zh-Hant, and its lang tag resolves back to it',
    (header) => {
      const locale = matchAcceptLanguageAmong(header, WITH_ZH_TW);
      expect(locale).toBe('zh-tw');
      const setId = LOCALE_FONT_SET[locale as keyof typeof LOCALE_FONT_SET];
      expect(setId).toBe('zh-Hant');
      const set = FONT_SET_REGISTRY[setId];
      expect(set.lang).toBe('zh-TW');
      expect(resolveFontSet(set.lang!).id).toBe(setId);
    },
  );

  it('keeps /zh Simplified now that zh-Hant exists', () => {
    expect(resolveFontSet('zh').id).toBe('zh-Hans');
    expect(resolveFontSet('zh-Hans').id).toBe('zh-Hans');
  });

  it('keeps FONT_SET_LOCALES equal to the eleven app locales, without zh-tw', () => {
    expect([...FONT_SET_LOCALES]).toEqual([...locales]);
    expect(FONT_SET_LOCALES).toHaveLength(11);
    expect(FONT_SET_LOCALES as readonly string[]).not.toContain('zh-tw');
  });

  it('declares every zh-Hant face in app/fonts.ts and reads it in theme.css', () => {
    const fontsTs = readFileSync(join(ROOT, 'app/fonts.ts'), 'utf8');
    const themeCss = readFileSync(join(ROOT, 'packages/design-system/theme.css'), 'utf8');
    const set = FONT_SET_REGISTRY['zh-Hant'];
    const variables = new Set(
      FONT_SET_ROLES.flatMap((role) =>
        (set.roles[role].members as readonly FontSetMember[]).map((m) =>
          fontSetMemberVar('zh-Hant', role, m.id),
        ),
      ),
    );
    expect(variables.size).toBe(3);
    for (const variable of variables) {
      expect(variable).toMatch(/^--font-set-zh-Hant-/);
      expect(fontsTs, `app/fonts.ts declares ${variable}`).toContain(`variable: '${variable}'`);
      expect(themeCss, `theme.css reads ${variable}`).toContain(`var(${variable},`);
    }
  });
});

describe('the zh-tw glossary motir-marketing mirrors', () => {
  it('is the zh-tw file, over every zh key, with a translation for each term', () => {
    expect(ZH_TW.locale).toBe('zh-tw');
    const missing = Object.keys(ZH.terms).filter((key) => !(key in ZH_TW.terms));
    expect(missing).toEqual([]);
    for (const [key, term] of Object.entries(ZH_TW.terms)) {
      expect(typeof term.translation, key).toBe('string');
      expect(term.translation.trim(), key).not.toBe('');
    }
  });

  it('bans the Taiwan words for issue and card as a name for a work item', () => {
    expect(ZH_TW.terms['work item']?.banned).toEqual(
      expect.arrayContaining(['議題', '問題', '卡片', '工單']),
    );
  });

  it.each(PRODUCT_NAMES)('names the product %s, keeping Motir verbatim', (name) => {
    expect(Object.keys(ZH_TW.terms)).toContain(name);
    expect(ZH_TW.terms[name]?.translation).toContain('Motir');
  });

  it.each(['vibe coding', 'Vibe the project'])('keeps %s in English', (key) => {
    expect(ZH_TW.terms[key]).toMatchObject({ doNotTranslate: true, translation: key });
  });

  it('writes no Simplified-only character', () => {
    const SIMPLIFIED_ONLY = /[项务软数据户计优级]/;
    const hits = Object.entries(ZH_TW.terms)
      .filter(([, term]) => SIMPLIFIED_ONLY.test(term.translation))
      .map(([key, term]) => `${key}: ${term.translation}`);
    expect(hits).toEqual([]);
  });
});
