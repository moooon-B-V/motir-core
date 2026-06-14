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

// Like `flatten`, but returns [keyPath, stringValue] pairs so a test can assert
// on the actual rendered copy (not just the key set).
function flattenEntries(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return flattenEntries(value as Record<string, unknown>, path);
    }
    return typeof value === 'string' ? [[path, value]] : [];
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

// Regression guard for `bug-zh-dashboards-reports-stale-glossary`: the locked zh
// PM glossary BANS `仪表板` for "dashboard" (must be `工作台`) and `问题` for the
// tracked-unit noun "work item" (must be `工作项`). Both had leaked into the
// dashboards/reports copy. Note: `问题` is ALSO legitimate Chinese for "problem"
// in the `出了点问题` / `出现问题` error idioms — those are NOT work items and must
// stay, so the `问题` check is scoped to the `dashboards` namespace, where every
// occurrence denoted a tracked unit (no error idioms live there).
describe('zh glossary (locked terms)', () => {
  const zhEntries = flattenEntries(zh as Record<string, unknown>);

  it('never renders the banned `仪表板`; "dashboard" is always `工作台`', () => {
    const leaks = zhEntries.filter(([, value]) => value.includes('仪表板'));
    expect(
      leaks.map(([path]) => path),
      `banned 仪表板 (use 工作台) at: ${leaks.map(([p]) => p).join(', ')}`,
    ).toEqual([]);
    // positive anchor: the dashboards landing title is the native term
    expect((zh as { dashboards: { title: string } }).dashboards.title).toBe('工作台');
  });

  it('never uses `问题` for the work-item noun in the dashboards namespace (use `工作项`)', () => {
    const leaks = zhEntries.filter(
      ([path, value]) => path.startsWith('dashboards.') && value.includes('问题'),
    );
    expect(
      leaks.map(([path]) => path),
      `banned work-item 问题 (use 工作项) at: ${leaks.map(([p]) => p).join(', ')}`,
    ).toEqual([]);
  });
});
