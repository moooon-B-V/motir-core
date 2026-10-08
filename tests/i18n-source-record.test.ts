import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenCatalogue } from '../scripts/i18n/sourceRecord';

// MOTIR-7745 — every catalogue records the English it was translated from, in
// `messages/sources/<locale>.json`, and that record stays in step with the
// catalogue: every key it records is a key en.json and the catalogue both hold,
// and every key the catalogue holds is recorded. `pnpm i18n:merge` writes the
// two files together, so a catalogue committed without its record (or a record
// left behind by a hand edit) fails here.
//
// STALE keys do not fail this gate — an English edit would otherwise fail every
// pull request until nine languages were re-translated. Staleness is what
// `pnpm i18n:status` reports. MISSING keys are parity's concern, not this one.
//
// zh predates the record, so it has none. MOTIR-7781 reviews zh's drift and
// baselines it, then takes zh out of UNTRACKED_LOCALES.

const ROOT = process.cwd();

/** Catalogues allowed to have no source record. Asserted TIGHT: a listed locale
 *  that gains a record fails. */
const UNTRACKED_LOCALES: string[] = [];

const isCatalogue = (f: string) => /^[a-z]{2,3}(-[A-Za-z0-9]+)?\.json$/.test(f) && f !== 'en.json';

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Every way the records under `rootDir/messages` disagree with their catalogues. */
function recordFindings(rootDir: string, untrackedAllowed: string[]): string[] {
  const messages = join(rootDir, 'messages');
  const sourcesDir = join(messages, 'sources');
  const out: string[] = [];
  const en = flattenCatalogue(readJson(join(messages, 'en.json')));
  const records = existsSync(sourcesDir)
    ? readdirSync(sourcesDir).filter((f) => f.endsWith('.json'))
    : [];

  for (const file of records) {
    const locale = file.replace(/\.json$/, '');
    const raw = readJson(join(sourcesDir, file));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.push(`sources/${file}: not a flat object`);
      continue;
    }
    const cataloguePath = join(messages, `${locale}.json`);
    if (!existsSync(cataloguePath)) {
      out.push(`sources/${file}: no messages/${locale}.json`);
      continue;
    }
    const catalogue = flattenCatalogue(readJson(cataloguePath));
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') out.push(`sources/${file}: ${key} is not a string`);
      if (!en.has(key)) out.push(`sources/${file}: ${key} is not in en.json`);
      if (!catalogue.has(key)) out.push(`sources/${file}: ${key} is not in ${locale}.json`);
    }
  }

  for (const file of readdirSync(messages).filter(isCatalogue)) {
    const locale = file.replace(/\.json$/, '');
    const hasRecord = records.includes(file);
    if (untrackedAllowed.includes(locale)) {
      if (hasRecord)
        out.push(
          `${locale}: listed as untracked but has a record — drop it from UNTRACKED_LOCALES`,
        );
      continue;
    }
    if (!hasRecord) {
      out.push(`${locale}: no messages/sources/${file} — commit what pnpm i18n:merge wrote`);
      continue;
    }
    const recorded = new Set(
      Object.keys(readJson(join(sourcesDir, file)) as Record<string, unknown>),
    );
    const unrecorded = [...flattenCatalogue(readJson(join(messages, file))).keys()].filter(
      (k) => en.has(k) && !recorded.has(k),
    );
    if (unrecorded.length) {
      out.push(
        `${locale}: ${unrecorded.length} key(s) with no recorded source (${unrecorded.slice(0, 5).join(', ')})`,
      );
    }
  }
  return out;
}

describe('i18n source record (MOTIR-7745)', () => {
  it('every record matches its catalogue, and every catalogue outside UNTRACKED_LOCALES has one', () => {
    expect(recordFindings(ROOT, UNTRACKED_LOCALES)).toEqual([]);
  });

  it('every UNTRACKED_LOCALES entry is a real catalogue', () => {
    const catalogues = readdirSync(join(ROOT, 'messages')).filter(isCatalogue);
    expect(UNTRACKED_LOCALES.filter((l) => !catalogues.includes(`${l}.json`))).toEqual([]);
  });

  describe('on a temp tree', () => {
    function fixture(files: Record<string, unknown>): string {
      const dir = mkdtempSync(join(tmpdir(), 'i18n-record-'));
      mkdirSync(join(dir, 'messages', 'sources'), { recursive: true });
      const all: Record<string, unknown> = {
        'en.json': { a: { one: 'One', two: 'Two' } },
        ...files,
      };
      for (const [rel, v] of Object.entries(all)) {
        writeFileSync(join(dir, 'messages', rel), `${JSON.stringify(v, null, 2)}\n`);
      }
      return dir;
    }
    function run(files: Record<string, unknown>, untracked: string[] = []): string[] {
      const dir = fixture(files);
      try {
        return recordFindings(dir, untracked);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const xx = { a: { one: 'Uno', two: 'Dos' } };

    it('fails a catalogue without a record', () => {
      expect(run({ 'xx.json': xx }).join('\n')).toMatch(/xx: no messages\/sources\/xx\.json/);
    });

    it('fails a record key the catalogue lacks', () => {
      const f = run({
        'xx.json': { a: { one: 'Uno' } },
        'sources/xx.json': { 'a.one': 'One', 'a.two': 'Two' },
      });
      expect(f.join('\n')).toMatch(/a\.two is not in xx\.json/);
    });

    it('fails a listed untracked locale that has a record', () => {
      const f = run({ 'xx.json': xx, 'sources/xx.json': { 'a.one': 'One', 'a.two': 'Two' } }, [
        'xx',
      ]);
      expect(f.join('\n')).toMatch(/listed as untracked/);
    });

    it('fails a catalogue key with no recorded source', () => {
      expect(run({ 'xx.json': xx, 'sources/xx.json': { 'a.one': 'One' } }).join('\n')).toMatch(
        /no recorded source/,
      );
    });

    it('passes a stale key — staleness is a status report, not a gate', () => {
      expect(
        run({ 'xx.json': xx, 'sources/xx.json': { 'a.one': 'One', 'a.two': 'Old two' } }),
      ).toEqual([]);
    });

    it("passes a catalogue missing a key — that is parity's concern", () => {
      expect(
        run({ 'xx.json': { a: { one: 'Uno' } }, 'sources/xx.json': { 'a.one': 'One' } }),
      ).toEqual([]);
    });
  });
});
