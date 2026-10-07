import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCatalogueLocales, status } from '../scripts/i18n/catalogue';

// MOTIR-7745 — every catalogue records the English it was translated from
// (`messages/sources/<locale>.json`), and every key is CURRENT: its recorded
// English equals today's `en.json`. A key whose English changed after it was
// translated is STALE, and this gate fails until `pnpm i18n:extract` +
// `pnpm i18n:merge` retranslate it — which is what stops a catalogue silently
// saying last month's sentence. A key in en.json the catalogue lacks is
// MISSING; a key the catalogue or record holds that en.json no longer does is
// an ORPHAN. All three fail.
//
// zh predates the record, so its keys are UNTRACKED (translated, source
// unknown). MOTIR-7781 reviews zh's drift and baselines it, and takes zh out of
// this list.

const ROOT = process.cwd();

/** Locales allowed to carry untracked keys. Asserted TIGHT below. */
const UNTRACKED_LOCALES: string[] = ['zh'];

function findings(rootDir: string, untrackedAllowed: string[]): string[] {
  const out: string[] = [];
  for (const s of status({ rootDir }).locales) {
    if (s.missing) out.push(`${s.locale}: ${s.missing} missing`);
    if (s.stale) out.push(`${s.locale}: ${s.stale} stale (${s.staleKeys.slice(0, 5).join(', ')})`);
    if (s.orphans) out.push(`${s.locale}: ${s.orphans} orphan`);
    if (s.untracked && !untrackedAllowed.includes(s.locale)) {
      out.push(`${s.locale}: ${s.untracked} untracked — run pnpm i18n:baseline only after review`);
    }
  }
  return out;
}

describe('i18n source record (MOTIR-7745)', () => {
  it('every catalogue is complete and current against en.json', () => {
    expect(findings(ROOT, UNTRACKED_LOCALES)).toEqual([]);
  });

  it('UNTRACKED_LOCALES is tight: each listed locale exists and still has untracked keys', () => {
    const byLocale = new Map(status({ rootDir: ROOT }).locales.map((s) => [s.locale, s]));
    const stale = UNTRACKED_LOCALES.filter((l) => !byLocale.get(l)?.untracked);
    expect(stale).toEqual([]);
  });

  it('checks every catalogue in messages/, zh among them', () => {
    expect(listCatalogueLocales(ROOT)).toContain('zh');
  });

  describe('fails on a temp catalogue that is', () => {
    function fixture(xx: unknown, record: unknown): string {
      const dir = mkdtempSync(join(tmpdir(), 'i18n-record-'));
      mkdirSync(join(dir, 'messages', 'sources'), { recursive: true });
      const w = (rel: string, v: unknown) =>
        writeFileSync(join(dir, 'messages', rel), `${JSON.stringify(v, null, 2)}\n`);
      w('en.json', { a: { one: 'One', two: 'Two' } });
      w('xx.json', xx);
      if (record) w('sources/xx.json', record);
      return dir;
    }
    const cases: [string, unknown, unknown, RegExp][] = [
      ['stale', { a: { one: 'Uno', two: 'Dos' } }, { 'a.one': 'One', 'a.two': 'Old two' }, /stale/],
      ['missing a key', { a: { one: 'Uno' } }, { 'a.one': 'One' }, /missing/],
      [
        'holding an orphan',
        { a: { one: 'Uno', two: 'Dos', three: 'Tres' } },
        { 'a.one': 'One', 'a.two': 'Two' },
        /orphan/,
      ],
      ['untracked and unlisted', { a: { one: 'Uno', two: 'Dos' } }, null, /untracked/],
    ];
    for (const [name, xx, record, expected] of cases) {
      it(name, () => {
        const dir = fixture(xx, record);
        try {
          const f = findings(dir, []);
          expect(f.join('\n')).toMatch(expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    it('and passes when complete and current', () => {
      const dir = fixture({ a: { one: 'Uno', two: 'Dos' } }, { 'a.one': 'One', 'a.two': 'Two' });
      try {
        expect(findings(dir, [])).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
