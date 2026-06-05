import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { locales } from '@/lib/i18n/locales';

// Guards the message catalogs against drift: every locale must define EXACTLY
// the same set of (nested) keys as the base `en` catalog — no missing keys (a
// missing-message runtime error in the other locale) and no orphan keys (dead
// translations). next-intl throws on a missing key in dev, so a parity gap would
// surface as a render crash for `zh` users; this turns it into a fast unit
// failure at the catalog level instead.

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? flatten(value as Record<string, unknown>, path)
      : [path];
  });
}

describe('message catalogs', () => {
  const enKeys = flatten(en).sort();

  it('ships a catalog per declared locale', () => {
    // `en` and `zh` are the two declared locales; both are imported here.
    expect(locales).toContain('en');
    expect(locales).toContain('zh');
  });

  it('zh has the exact same key set as en (no missing, no orphan keys)', () => {
    const zhKeys = flatten(zh as Record<string, unknown>).sort();
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
    const orphanInZh = zhKeys.filter((k) => !enKeys.includes(k));
    expect(missingInZh, `keys missing from zh.json: ${missingInZh.join(', ')}`).toEqual([]);
    expect(orphanInZh, `orphan keys in zh.json: ${orphanInZh.join(', ')}`).toEqual([]);
  });
});
