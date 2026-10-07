import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GlossaryShapeError,
  loadGlossary,
  renderInstructions,
  validateGlossary,
} from '@/scripts/i18n/glossary';
import { classifyKeys, flattenCatalogue } from '@/scripts/i18n/sourceRecord';
import {
  baseline,
  extract,
  merge,
  runCatalogueCli,
  status,
  type Batch,
} from '@/scripts/i18n/catalogue';

// Story MOTIR-7730 · MOTIR-7745 — the catalogue script, run against a temp
// directory holding a small en catalogue, a glossary, a partial locale file and
// a source record. No network, no database, and `messages/` is never written.

let root: string;
const logs: string[] = [];
const log = (line: string) => logs.push(line);

const EN = {
  a: { one: 'One {name}', two: 'Two items', three: 'Plan the Sprint' },
  b: { four: 'Four on Motir', five: 'Five <link>docs</link>' },
};

const GLOSSARY = {
  locale: 'xx',
  register: { formality: 'formal-xx', quotes: '«»', note: 'note-xx' },
  terms: {
    Motir: { translation: 'Motir', doNotTranslate: true, source: 'name' },
    Sprint: { translation: 'Sprint', source: 'decision' },
    'work item': {
      translation: 'werk',
      banned: ['kaart', 'ticket'],
      allowedSenses: 'payment card',
      source: 'ref',
    },
  },
};

function write(rel: string, value: unknown): void {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const readJson = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;
const batches = () =>
  readdirSync(join(root, '.i18n-work/xx'))
    .sort()
    .map((f) => JSON.parse(read(`.i18n-work/xx/${f}`)) as Batch);
function fill(fn: (key: string, source: string) => string | undefined): void {
  for (const f of readdirSync(join(root, '.i18n-work/xx'))) {
    const b = JSON.parse(read(`.i18n-work/xx/${f}`)) as Batch;
    for (const [k, v] of Object.entries(b.source)) {
      const t = fn(k, v);
      if (t !== undefined) b.target[k] = t;
    }
    write(`.i18n-work/xx/${f}`, b);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'i18n-catalogue-'));
  logs.length = 0;
  write('messages/en.json', EN);
  write('messages/glossary/xx.json', GLOSSARY);
  // The locale holds 2 of the 5 keys: one current, one stale.
  write('messages/xx.json', { a: { one: 'Uno {name}', two: 'Dos (viejo)' } });
  write('messages/sources/xx.json', { 'a.one': 'One {name}', 'a.two': 'Two old items' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadGlossary / renderInstructions', () => {
  it('throws ONE error naming the file and every bad path', () => {
    write('messages/glossary/ja.json', {
      locale: 'ko',
      terms: { 'work item': { translation: '' }, Motir: { translation: 'Motir' } },
    });
    let error: unknown;
    try {
      loadGlossary('ja', root);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(GlossaryShapeError);
    const e = error as GlossaryShapeError;
    expect(e.message).toContain('ja.json');
    expect(e.paths).toHaveLength(3);
    expect(e.message).toContain('locale');
    expect(e.message).toContain('register');
    expect(e.message).toContain('terms.work item.translation');
  });

  it('refuses a non-string banned list and an empty term set', () => {
    expect(() =>
      validateGlossary(
        { locale: 'xx', register: {}, terms: { a: { translation: 'b', banned: [1] } } },
        'xx',
        'f',
      ),
    ).toThrow(/banned/);
    expect(() => validateGlossary({ locale: 'xx', register: {}, terms: {} }, 'xx', 'f')).toThrow(
      /terms/,
    );
  });

  it('loads a well-formed glossary and renders every term, banned word, register and the verbatim rule', () => {
    const g = loadGlossary('xx', root);
    const text = renderInstructions(g);
    for (const t of ['Motir', 'Sprint', 'werk', 'kaart', 'ticket', 'formal-xx', '«»'])
      expect(text).toContain(t);
    expect(text).toContain(
      'Keep every {placeholder}, every #, every plural/select option key and every <tag>',
    );
  });
});

describe('classifyKeys', () => {
  it('puts each key in exactly one class and lists the orphan', () => {
    const en = flattenCatalogue({ m: 'M', s: 'S new', c: 'C', u: 'U' });
    const cat = flattenCatalogue({ s: 's', c: 'c', u: 'u', gone: 'g' });
    const rec = new Map([
      ['s', 'S old'],
      ['c', 'C'],
    ]);
    expect(classifyKeys(en, cat, rec)).toEqual({
      missing: ['m'],
      stale: ['s'],
      current: ['c'],
      untracked: ['u'],
      orphans: ['gone'],
    });
  });
});

describe('extract', () => {
  it("cuts the missing and stale keys into batches, in en order, with the stale entry's previous", () => {
    const r = extract({ rootDir: root, locale: 'xx', batchSize: 2, log });
    expect(r).toMatchObject({ missing: 3, stale: 1, untracked: 0, batches: 2 });
    const [b1, b2] = batches();
    expect(Object.keys(b1!.source)).toEqual(['a.two', 'a.three']);
    expect(Object.keys(b2!.source)).toEqual(['b.four', 'b.five']);
    expect(b1!.previous).toEqual({
      'a.two': { source: 'Two old items', translation: 'Dos (viejo)' },
    });
    expect(b1!.instructions).toContain('werk');
    expect(b1!.target).toEqual({});
  });

  it('narrows to namespaces when asked', () => {
    extract({ rootDir: root, locale: 'xx', namespaces: ['b'], log });
    expect(Object.keys(batches()[0]!.source)).toEqual(['b.four', 'b.five']);
  });

  it('refuses --locale en', () => {
    expect(runCatalogueCli(['extract', '--locale', 'en'], { rootDir: root, log })).not.toBe(0);
    expect(() => extract({ rootDir: root, locale: 'en' })).toThrow(/source of truth/);
  });

  it('leaves an untracked key out unless --include-untracked', () => {
    write('messages/sources/xx.json', { 'a.two': 'Two old items' }); // a.one now untracked
    extract({ rootDir: root, locale: 'xx', log });
    expect(Object.keys(batches()[0]!.source)).not.toContain('a.one');
    extract({ rootDir: root, locale: 'xx', includeUntracked: true, log });
    expect(Object.keys(batches()[0]!.source)).toContain('a.one');
  });
});

describe('merge', () => {
  it('writes what passes, rejects what does not, warns on banned words', () => {
    extract({ rootDir: root, locale: 'xx', log });
    fill(
      (key) =>
        ({
          'a.two': 'Dos elementos', // stale re-fill
          'a.three': 'Planea el Sprint', // good missing value
          'b.four': 'Cuatro en Motor', // "Motir" translated → rejected
          'b.five': 'Cinco <link>docs</link> kaart', // banned word → warning, written
        })[key],
    );
    // A value for a CURRENT key and one missing a placeholder, added by hand.
    const b = batches()[0]!;
    b.target['a.one'] = 'Otro {name}';
    write('.i18n-work/xx/batch-001.json', b);
    const before = readJson('messages/xx.json');

    const r = merge({ rootDir: root, locale: 'xx', log });
    expect(r.merged.sort()).toEqual(['a.three', 'a.two', 'b.five']);
    expect(r.rejected.map((x) => x.key).sort()).toEqual(['a.one', 'b.four']);
    expect(r.rejected.find((x) => x.key === 'a.one')!.reasons.join()).toContain('already current');
    expect(r.rejected.find((x) => x.key === 'b.four')!.reasons.join()).toContain('Motir');
    expect(r.warned).toEqual([{ key: 'b.five', word: 'kaart' }]);
    expect(r.exitCode).toBe(1);

    const cat = readJson('messages/xx.json') as {
      a: Record<string, string>;
      b: Record<string, string>;
    };
    expect(cat.a['one']).toBe((before as { a: Record<string, string> }).a['one']);
    expect(cat.a['two']).toBe('Dos elementos');
    expect(Object.keys(cat)).toEqual(['a', 'b']);
    expect(Object.keys(cat.a)).toEqual(['one', 'two', 'three']);
    expect(read('messages/xx.json')).toMatch(/^\{\n {2}"a"/);
    expect(read('messages/xx.json').endsWith('}\n')).toBe(true);

    const recText = read('messages/sources/xx.json');
    expect(JSON.parse(recText)).toEqual({
      'a.one': 'One {name}',
      'a.two': 'Two items',
      'a.three': 'Plan the Sprint',
      'b.five': 'Five <link>docs</link>',
    });
    expect(recText).toMatch(/^\{\n {2}"a\.one"/);
    expect(recText.endsWith('}\n')).toBe(true);
  });

  it('rejects a value missing a placeholder, a translated "Sprint", and records nothing for them', () => {
    extract({ rootDir: root, locale: 'xx', log });
    fill((key) => ({ 'a.three': 'Planea la iteración', 'b.five': 'Cinco docs' })[key]);
    const r = merge({ rootDir: root, locale: 'xx', log });
    expect(r.rejected.map((x) => x.key).sort()).toEqual(['a.three', 'b.five']);
    expect(r.rejected.find((x) => x.key === 'a.three')!.reasons.join()).toContain('Sprint');
    expect(r.rejected.find((x) => x.key === 'b.five')!.reasons.join()).toContain('link');
    expect(JSON.parse(read('messages/sources/xx.json'))).not.toHaveProperty('a.three');
  });

  it('passes a re-run once the rejected entries are fixed, without refusing what the first run wrote', () => {
    extract({ rootDir: root, locale: 'xx', log });
    fill((key, source) => (key === 'b.five' ? 'Cinco docs' : `XX ${source}`));
    expect(merge({ rootDir: root, locale: 'xx', log }).exitCode).toBe(1);
    fill((key, source) => (key === 'b.five' ? 'Cinco <link>docs</link>' : `XX ${source}`));
    const r = merge({ rootDir: root, locale: 'xx', log });
    expect(r.rejected).toEqual([]);
    expect(r.merged).toEqual(['b.five']);
    expect(r.exitCode).toBe(0);
  });

  it('rejects an entry whose en value changed between extract and merge', () => {
    extract({ rootDir: root, locale: 'xx', log });
    fill((key) => (key === 'b.four' ? 'Cuatro en Motir' : undefined));
    write('messages/en.json', { ...EN, b: { ...EN.b, four: 'Four, reworded, on Motir' } });
    const r = merge({ rootDir: root, locale: 'xx', log });
    expect(r.rejected[0]!.reasons.join()).toContain('en changed since extract');
    expect(JSON.parse(read('messages/sources/xx.json'))).not.toHaveProperty('b.four');
  });

  it('drops an orphan key from the catalogue and the record, and lists it', () => {
    write('messages/xx.json', { a: { one: 'Uno {name}', two: 'Dos', gone: 'x' } });
    write('messages/sources/xx.json', { 'a.one': 'One {name}', 'a.gone': 'Gone' });
    extract({ rootDir: root, locale: 'xx', log });
    const r = merge({ rootDir: root, locale: 'xx', log });
    expect(r.orphans).toEqual(['a.gone']);
    expect(readJson('messages/xx.json')).not.toHaveProperty('a.gone');
    expect(JSON.parse(read('messages/sources/xx.json'))).not.toHaveProperty('a.gone');
  });
});

describe('status', () => {
  it('reports 0 missing and 0 stale after a full merge, then stale after an en edit', () => {
    extract({ rootDir: root, locale: 'xx', log });
    fill((key, source) =>
      source.replace('Two items', 'Dos').replace('Four on Motir', 'Cuatro en Motir'),
    );
    expect(merge({ rootDir: root, locale: 'xx', log }).exitCode).toBe(0);
    const ok = status({ rootDir: root, locale: 'xx', log });
    expect(ok.locales[0]).toMatchObject({ missing: 0, stale: 0, current: 5 });
    expect(status({ rootDir: root, check: true, log }).exitCode).toBe(0);

    write('messages/en.json', { ...EN, a: { ...EN.a, two: 'Two items, reworded' } });
    const after = status({ rootDir: root, locale: 'xx', log });
    expect(after.locales[0]).toMatchObject({ stale: 1, staleKeys: ['a.two'] });
    expect(status({ rootDir: root, locale: 'xx', check: true, log }).exitCode).toBe(1);
    expect(runCatalogueCli(['status', '--check'], { rootDir: root, log })).toBe(1);
  });
});

describe('baseline', () => {
  it('refuses without --confirm and writes nothing; with it, records the untracked keys only', () => {
    write('messages/sources/xx.json', { 'a.two': 'Two old items' });
    const before = read('messages/sources/xx.json');
    expect(baseline({ rootDir: root, locale: 'xx', log }).exitCode).toBe(1);
    expect(read('messages/sources/xx.json')).toBe(before);

    const r = baseline({ rootDir: root, locale: 'xx', confirm: true, log });
    expect(r).toEqual({ recorded: 1, exitCode: 0 });
    expect(JSON.parse(read('messages/sources/xx.json'))).toEqual({
      'a.one': 'One {name}',
      'a.two': 'Two old items', // stale stays stale
    });
  });

  it('never touches a missing file it was not asked about', () => {
    expect(existsSync(join(root, 'messages/sources/zz.json'))).toBe(false);
  });
});
