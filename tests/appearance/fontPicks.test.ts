import { describe, expect, it } from 'vitest';
import { FONT_SET_LOCALES, FONT_SET_REGISTRY, LOCALE_FONT_SET } from '@motir/design-system';
import { FONT_PICK_COLUMN, isFontSetMemberOfLocale } from '@/lib/appearance/fontPicks';

// Pure tests for the per-locale font-pick helpers (MOTIR-7894): membership is
// derived from the font-set registry, so these assert the derivation rather
// than a hard-coded list.

describe('isFontSetMemberOfLocale', () => {
  it('accepts a member of any role of the locale’s own set', () => {
    expect(isFontSetMemberOfLocale('ja', 'noto-sans-jp')).toBe(true);
    expect(isFontSetMemberOfLocale('ja', 'm-plus-rounded-1c')).toBe(true);
    expect(isFontSetMemberOfLocale('ja', 'noto-serif-jp')).toBe(true);
    expect(isFontSetMemberOfLocale('zh', 'lxgw-wenkai-tc')).toBe(true);
    expect(isFontSetMemberOfLocale('ko', 'nanum-gothic')).toBe(true);
  });

  it('refuses another locale’s member and an unknown id', () => {
    expect(isFontSetMemberOfLocale('ja', 'noto-sans-kr')).toBe(false);
    expect(isFontSetMemberOfLocale('ko', 'noto-sans-jp')).toBe(false);
    expect(isFontSetMemberOfLocale('zh', 'comic-sans')).toBe(false);
  });

  it('accepts nothing for a Latin locale, not even the type-pairing placeholder', () => {
    for (const locale of FONT_SET_LOCALES) {
      if (LOCALE_FONT_SET[locale] !== 'latin') continue;
      expect(isFontSetMemberOfLocale(locale, 'type-pairing')).toBe(false);
    }
  });

  it('accepts every real member the registry lists for each CJK locale', () => {
    for (const locale of FONT_SET_LOCALES) {
      const set = FONT_SET_REGISTRY[LOCALE_FONT_SET[locale]];
      for (const role of Object.values(set.roles)) {
        for (const m of role.members) {
          expect(isFontSetMemberOfLocale(locale, m.id)).toBe(m.source.kind !== 'type-pairing');
        }
      }
    }
  });
});

describe('FONT_PICK_COLUMN', () => {
  it('names one distinct column per locale', () => {
    expect(Object.keys(FONT_PICK_COLUMN).sort()).toEqual([...FONT_SET_LOCALES].sort());
    expect(new Set(Object.values(FONT_PICK_COLUMN)).size).toBe(FONT_SET_LOCALES.length);
  });
});
