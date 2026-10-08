import { describe, expect, it } from 'vitest';
import { FONT_SET_LOCALES } from '@motir/design-system';
import { locales } from '@/lib/i18n/locales';

// MOTIR-7843 — the font-set registry holds its OWN copy of the app's locale list,
// because @motir/design-system must not import the app. This is the one test that
// keeps the two from drifting: a locale added to the app (lib/i18n/locales.ts,
// MOTIR-7730) without a row in FONT_SET_REGISTRY's LOCALE_FONT_SET would render
// in a set nobody chose.
describe('font-set locales ↔ the app’s locales', () => {
  it('lists the same locales', () => {
    expect([...FONT_SET_LOCALES].sort()).toEqual([...locales].sort());
  });
});
