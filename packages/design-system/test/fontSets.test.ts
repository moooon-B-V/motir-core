import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  FONT_SET_LOCALES,
  FONT_SET_REGISTRY,
  FONT_SET_ROLES,
  FONT_SET_IDS,
  LOCALE_FONT_SET,
  fontSetMemberVar,
  fontSetPickAttributes,
  isFontSetLocale,
  resolveFontSet,
  resolveFontSetMember,
  type FontSetId,
  type FontSetMember,
} from '../src/index';

// MOTIR-7843 — the locale → font-set registry. The EXPECTED rows below are
// copied by hand from docs/typography/font-sets.md as committed in 144b53826
// (MOTIR-7841), NOT derived from the registry: a check computed from the thing
// it checks always passes. Change a row in both places or neither.
const EXPECTED_LOCALE_SET: Record<string, string> = {
  en: 'latin',
  de: 'latin',
  fr: 'latin',
  es: 'latin',
  it: 'latin',
  nl: 'latin',
  pl: 'latin',
  pt: 'latin',
  zh: 'zh-Hans',
  ja: 'ja',
  ko: 'ko',
};

// set → role → [default, ...every member id, in the doc's order], plus each
// member's `in dooooWeb` tag.
const EXPECTED_SETS: Record<
  string,
  Record<string, { default: string; members: [string, boolean][] }>
> = {
  latin: {
    sans: { default: 'type-pairing', members: [['type-pairing', false]] },
    serif: { default: 'type-pairing', members: [['type-pairing', false]] },
    mono: { default: 'type-pairing', members: [['type-pairing', false]] },
  },
  'zh-Hans': {
    sans: { default: 'noto-sans-sc', members: [['noto-sans-sc', false]] },
    serif: {
      default: 'noto-serif-sc',
      members: [
        ['noto-serif-sc', true],
        ['lxgw-wenkai-tc', true],
      ],
    },
    mono: { default: 'noto-sans-sc', members: [['noto-sans-sc', false]] },
  },
  ja: {
    sans: {
      default: 'noto-sans-jp',
      members: [
        ['noto-sans-jp', true],
        ['m-plus-rounded-1c', true],
      ],
    },
    serif: { default: 'noto-serif-jp', members: [['noto-serif-jp', false]] },
    mono: { default: 'noto-sans-jp', members: [['noto-sans-jp', false]] },
  },
  ko: {
    sans: {
      default: 'noto-sans-kr',
      members: [
        ['noto-sans-kr', true],
        ['nanum-gothic', true],
      ],
    },
    serif: { default: 'noto-serif-kr', members: [['noto-serif-kr', false]] },
    mono: { default: 'noto-sans-kr', members: [['noto-sans-kr', false]] },
  },
};

const allMembers = (): {
  setId: FontSetId;
  role: (typeof FONT_SET_ROLES)[number];
  m: FontSetMember;
}[] =>
  FONT_SET_IDS.flatMap((setId) =>
    FONT_SET_ROLES.flatMap((role) =>
      (FONT_SET_REGISTRY[setId].roles[role].members as readonly FontSetMember[]).map((m) => ({
        setId,
        role,
        m,
      })),
    ),
  );

describe('font-set registry shape', () => {
  it('maps exactly the eleven locales, in the order the app lists them', () => {
    expect(FONT_SET_LOCALES).toEqual([
      'en',
      'zh',
      'ja',
      'ko',
      'de',
      'fr',
      'es',
      'it',
      'nl',
      'pl',
      'pt',
    ]);
    expect(Object.keys(LOCALE_FONT_SET)).toEqual([...FONT_SET_LOCALES]);
  });

  it('sends every locale to a registered set, and zh / ja / ko to three different ones', () => {
    for (const locale of FONT_SET_LOCALES) {
      expect(FONT_SET_IDS).toContain(LOCALE_FONT_SET[locale]);
    }
    expect(new Set([LOCALE_FONT_SET.zh, LOCALE_FONT_SET.ja, LOCALE_FONT_SET.ko]).size).toBe(3);
  });

  it('covers sans, serif and mono in every set, each with a default that is one of its members', () => {
    for (const setId of FONT_SET_IDS) {
      for (const role of FONT_SET_ROLES) {
        const r = FONT_SET_REGISTRY[setId].roles[role];
        expect(r.members.length).toBeGreaterThan(0);
        expect(r.members.map((m) => m.id)).toContain(r.default);
        const ids = r.members.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('gives every distinct face its own variable, and a re-used face its owner’s', () => {
    const byFace = new Map<string, string>();
    for (const { setId, role, m } of allMembers()) {
      const v = fontSetMemberVar(setId, role, m.id);
      if (m.source.kind === 'type-pairing') {
        expect(v).toBeNull();
        continue;
      }
      expect(v).toMatch(/^--font-set-[A-Za-z-]+-(sans|serif|mono)-[a-z0-9-]+$/);
      const face = `${setId}/${m.source.googleFamily}`;
      if (m.sameFaceAs) {
        expect(v).toBe(fontSetMemberVar(setId, m.sameFaceAs, m.id));
      }
      // One face ↔ one variable, in both directions.
      if (byFace.has(face)) expect(byFace.get(face)).toBe(v);
      byFace.set(face, v!);
    }
    expect(new Set(byFace.values()).size).toBe(byFace.size);
    expect(fontSetMemberVar('ja', 'sans', 'noto-sans-jp')).toBe('--font-set-ja-sans-noto-sans-jp');
    expect(fontSetMemberVar('ja', 'mono', 'noto-sans-jp')).toBe('--font-set-ja-sans-noto-sans-jp');
    expect(fontSetMemberVar('ja', 'sans', 'not-a-member')).toBeNull();
  });

  it('records each google member with its next/font export name', () => {
    expect(resolveFontSetMember('zh-Hans', 'serif', 'lxgw-wenkai-tc').source).toEqual({
      kind: 'next/font/google',
      googleFamily: 'LXGW_WenKai_TC',
    });
    expect(FONT_SET_REGISTRY.latin.cjk).toBe(false);
    expect(
      FONT_SET_REGISTRY.ja.cjk && FONT_SET_REGISTRY.ko.cjk && FONT_SET_REGISTRY['zh-Hans'].cjk,
    ).toBe(true);
  });
});

describe('font-set registry equals docs/typography/font-sets.md', () => {
  it('locale → set rows', () => {
    expect({ ...LOCALE_FONT_SET }).toEqual(EXPECTED_LOCALE_SET);
  });

  it('every set’s members and defaults, per role', () => {
    const actual = Object.fromEntries(
      FONT_SET_IDS.map((setId) => [
        setId,
        Object.fromEntries(
          FONT_SET_ROLES.map((role) => {
            const r = FONT_SET_REGISTRY[setId].roles[role];
            return [
              role,
              {
                default: r.default,
                members: (r.members as readonly FontSetMember[]).map((m) => [m.id, m.inDooooWeb]),
              },
            ];
          }),
        ),
      ]),
    );
    expect(actual).toEqual(EXPECTED_SETS);
  });
});

describe('resolveFontSet', () => {
  it('matches the primary subtag, case-insensitively', () => {
    expect(resolveFontSet('ja-JP').id).toBe('ja');
    expect(resolveFontSet('PT-br').id).toBe('latin');
    expect(resolveFontSet('zh-Hans').id).toBe('zh-Hans');
    expect(resolveFontSet('zh').id).toBe('zh-Hans');
    expect(resolveFontSet('KO').id).toBe('ko');
  });

  it('falls back to Latin for an empty or unknown tag, and the guard tells the two apart', () => {
    expect(resolveFontSet('').id).toBe('latin');
    expect(resolveFontSet('xx').id).toBe('latin');
    expect(isFontSetLocale('xx')).toBe(false);
    expect(isFontSetLocale('pl')).toBe(true);
    expect(isFontSetLocale(undefined)).toBe(false);
  });

  it('gives each CJK set the lang tag the app renders on <html>', () => {
    expect(FONT_SET_REGISTRY['zh-Hans'].lang).toBe('zh');
    expect(FONT_SET_REGISTRY.ja.lang).toBe('ja');
    expect(FONT_SET_REGISTRY.ko.lang).toBe('ko');
    expect(FONT_SET_REGISTRY.latin.lang).toBeNull();
  });
});

describe('resolveFontSetMember', () => {
  it('returns the named member when the role has it', () => {
    expect(resolveFontSetMember('ja', 'sans', 'm-plus-rounded-1c').id).toBe('m-plus-rounded-1c');
    expect(resolveFontSetMember('ko', 'sans', 'nanum-gothic').family).toBe('Nanum Gothic');
  });

  it('degrades an unknown, missing or other-set id to the role’s default', () => {
    expect(resolveFontSetMember('ja', 'sans', '<unknown>').id).toBe('noto-sans-jp');
    expect(resolveFontSetMember('ja', 'serif').id).toBe('noto-serif-jp');
    // A ko member named on the ja set is not borrowed across sets.
    expect(resolveFontSetMember('ja', 'sans', 'nanum-gothic').id).toBe('noto-sans-jp');
    expect(resolveFontSetMember('latin', 'mono', 'noto-sans-jp').id).toBe('type-pairing');
  });
});

// MOTIR-7897 — the attributes a pick puts on <html>, derived from the registry.
describe('fontSetPickAttributes', () => {
  it('names the role a non-default member replaces, and only that role', () => {
    expect(fontSetPickAttributes('ja', 'm-plus-rounded-1c')).toEqual({
      'data-font-set-sans': 'm-plus-rounded-1c',
    });
    expect(fontSetPickAttributes('zh', 'lxgw-wenkai-tc')).toEqual({
      'data-font-set-serif': 'lxgw-wenkai-tc',
    });
    expect(fontSetPickAttributes('ko', 'nanum-gothic')).toEqual({
      'data-font-set-sans': 'nanum-gothic',
    });
  });

  it('returns nothing for a default, null, an unknown id or another set’s member', () => {
    expect(fontSetPickAttributes('ja', 'noto-sans-jp')).toEqual({});
    expect(fontSetPickAttributes('ja', null)).toEqual({});
    expect(fontSetPickAttributes('ja', 'comic-sans')).toEqual({});
    expect(fontSetPickAttributes('ja', 'nanum-gothic')).toEqual({});
  });

  it('returns nothing for every Latin locale, the type-pairing placeholder included', () => {
    for (const locale of FONT_SET_LOCALES) {
      if (LOCALE_FONT_SET[locale] !== 'latin') continue;
      expect(fontSetPickAttributes(locale, 'type-pairing'), locale).toEqual({});
    }
  });

  it('only ever returns an attribute theme.css has a :lang() rule for', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'theme.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = new Set(
      [...css.matchAll(/:lang\(([\w-]+)\)\[data-font-set-(sans|serif|mono)='([\w-]+)'\]/g)].map(
        (m) => `${m[1]}|data-font-set-${m[2]}|${m[3]}`,
      ),
    );
    let seen = 0;
    for (const locale of FONT_SET_LOCALES) {
      const set = FONT_SET_REGISTRY[LOCALE_FONT_SET[locale]];
      for (const role of FONT_SET_ROLES) {
        for (const m of set.roles[role].members as readonly FontSetMember[]) {
          for (const [attr, id] of Object.entries(fontSetPickAttributes(locale, m.id))) {
            expect(rules.has(`${set.lang}|${attr}|${id}`), `${locale} ${attr}=${id}`).toBe(true);
            seen++;
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
