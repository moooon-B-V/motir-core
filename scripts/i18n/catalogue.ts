/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareMessageShape } from './messageShape';
import { doNotTranslateTerms, keptLatinTerms, loadGlossary, renderInstructions } from './glossary';
import {
  arrayParentOf,
  buildCatalogue,
  cataloguePath,
  classifyKeys,
  flattenCatalogue,
  readJson,
  readRecord,
  writeJson,
  writeRecord,
  type Catalogue,
  type FlatCatalogue,
} from './sourceRecord';

// The catalogue translation CLI (Story MOTIR-7730 · MOTIR-7745). It owns
// everything around a translation that has to be EXACT — which keys, under which
// terms, in what order, against which English, and whether the result is safe to
// ship — and calls NO model API: the model filling a batch is the agent running
// the catalogue work item. See scripts/i18n/README.md for the loop.
//
//   extract  --locale <l> [--batch-size N] [--include-untracked] [--namespaces a,b]
//   merge    --locale <l>
//   status   [--locale <l>] [--check]
//   baseline --locale <l> --confirm

export interface CatalogueOptions {
  /** Repository root holding `messages/`; tests point it at a temp dir. */
  rootDir: string;
  log?: (line: string) => void;
}

export interface Batch {
  locale: string;
  includeUntracked?: boolean;
  instructions: string;
  source: Record<string, string>;
  previous: Record<string, { source: string; translation: string }>;
  target: Record<string, string>;
}

function workDir(rootDir: string, locale: string): string {
  return join(rootDir, '.i18n-work', locale);
}

function loadEn(rootDir: string): { en: Catalogue; enFlat: FlatCatalogue } {
  const en = readJson<Catalogue>(cataloguePath(rootDir, 'en'));
  if (!en) throw new Error(`${cataloguePath(rootDir, 'en')} not found`);
  return { en, enFlat: flattenCatalogue(en) };
}

function loadLocale(rootDir: string, locale: string): FlatCatalogue {
  return flattenCatalogue(readJson<Catalogue>(cataloguePath(rootDir, locale)) ?? {});
}

class UsageError extends Error {}

function refuseEn(locale: string | undefined): string {
  if (!locale) throw new UsageError('--locale is required');
  if (locale === 'en')
    throw new UsageError('en.json is the source of truth; --locale en is refused');
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(locale))
    throw new UsageError(`not a locale code: ${locale}`);
  return locale;
}

// ── extract ────────────────────────────────────────────────────────────────

export interface ExtractResult {
  missing: number;
  stale: number;
  untracked: number;
  batches: number;
  files: string[];
}

export function extract(
  opts: CatalogueOptions & {
    locale: string;
    batchSize?: number;
    includeUntracked?: boolean;
    namespaces?: string[];
  },
): ExtractResult {
  const locale = refuseEn(opts.locale);
  const { en, enFlat } = loadEn(opts.rootDir);
  const glossary = loadGlossary(locale, opts.rootDir);
  const catalogue = loadLocale(opts.rootDir, locale);
  const record = readRecord(opts.rootDir, locale);
  const classes = classifyKeys(enFlat, catalogue, record);
  const inScope = (key: string) =>
    !opts.namespaces?.length || opts.namespaces.includes(key.split('.')[0]!);
  const wanted = new Set([
    ...classes.missing,
    ...classes.stale,
    ...(opts.includeUntracked ? classes.untracked : []),
  ]);
  const keys = [...enFlat.keys()].filter((k) => wanted.has(k) && inScope(k));
  const stale = new Set(classes.stale);
  const size = Math.max(1, opts.batchSize ?? 150);

  // Chunk in en order, never splitting an array's elements across batches.
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const key of keys) {
    const parent = arrayParentOf(en, key);
    const lastParent = current.length ? arrayParentOf(en, current[current.length - 1]!) : null;
    if (current.length >= size && !(parent && parent === lastParent)) {
      chunks.push(current);
      current = [];
    }
    current.push(key);
  }
  if (current.length) chunks.push(current);

  const dir = workDir(opts.rootDir, locale);
  rmSync(dir, { recursive: true, force: true });
  const instructions = renderInstructions(glossary);
  const files: string[] = [];
  chunks.forEach((chunk, i) => {
    const batch: Batch = {
      locale,
      ...(opts.includeUntracked ? { includeUntracked: true } : {}),
      instructions,
      source: Object.fromEntries(chunk.map((k) => [k, enFlat.get(k)!])),
      previous: Object.fromEntries(
        chunk
          .filter((k) => stale.has(k))
          .map((k) => [k, { source: record!.get(k)!, translation: catalogue.get(k)! }]),
      ),
      target: {},
    };
    const file = join(dir, `batch-${String(i + 1).padStart(3, '0')}.json`);
    writeJson(file, batch);
    files.push(file);
  });

  const scoped = (list: string[]) => list.filter(inScope).length;
  const result: ExtractResult = {
    missing: scoped(classes.missing),
    stale: scoped(classes.stale),
    untracked: scoped(classes.untracked),
    batches: chunks.length,
    files,
  };
  opts.log?.(
    `${locale}: ${result.missing} missing, ${result.stale} stale, ${result.untracked} untracked` +
      `${opts.includeUntracked ? ' (included)' : ' (not extracted; --include-untracked to re-fill)'}` +
      ` → ${result.batches} batch file(s) in ${dir}`,
  );
  return result;
}

// ── merge ──────────────────────────────────────────────────────────────────

export interface MergeResult {
  merged: string[];
  rejected: { key: string; reasons: string[] }[];
  warned: { key: string; word: string }[];
  stillMissing: number;
  stillStale: number;
  orphans: string[];
  exitCode: number;
}

function containsWord(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(haystack);
}

export function merge(opts: CatalogueOptions & { locale: string }): MergeResult {
  const locale = refuseEn(opts.locale);
  const { en, enFlat } = loadEn(opts.rootDir);
  const glossary = loadGlossary(locale, opts.rootDir);
  const catalogue = loadLocale(opts.rootDir, locale);
  const record = readRecord(opts.rootDir, locale) ?? new Map<string, string>();
  const classes = classifyKeys(enFlat, catalogue, record);
  const missing = new Set(classes.missing);
  const stale = new Set(classes.stale);
  const untracked = new Set(classes.untracked);
  const dnt = doNotTranslateTerms(glossary);
  const latin = keptLatinTerms(glossary);
  const bannedLists = Object.values(glossary.terms).flatMap((t) => t.banned ?? []);

  const dir = workDir(opts.rootDir, locale);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^batch-\d+\.json$/.test(f))
        .sort()
    : [];

  const result: MergeResult = {
    merged: [],
    rejected: [],
    warned: [],
    stillMissing: 0,
    stillStale: 0,
    orphans: classes.orphans,
    exitCode: 0,
  };

  for (const file of files) {
    const batch = readJson<Batch>(join(dir, file));
    if (!batch) continue;
    for (const [key, value] of Object.entries(batch.target ?? {})) {
      const reasons: string[] = [];
      const enValue = enFlat.get(key);
      // Re-running merge after fixing a rejection meets the entries an earlier
      // run already wrote; those are done, not refused.
      if (enValue !== undefined && catalogue.get(key) === value && record.get(key) === enValue)
        continue;
      if (enValue === undefined) {
        reasons.push('not a key in en.json');
      } else if (typeof value !== 'string' || value === '') {
        reasons.push('empty or not a string');
      } else {
        if (batch.source?.[key] !== enValue) reasons.push('en changed since extract — re-extract');
        const allowed =
          missing.has(key) ||
          stale.has(key) ||
          (batch.includeUntracked === true && untracked.has(key));
        if (!allowed)
          reasons.push(
            untracked.has(key) ? 'untracked (extract with --include-untracked)' : 'already current',
          );
        for (const v of compareMessageShape(enValue, value, locale))
          reasons.push(`${v.kind}: ${v.detail}`);
        for (const term of dnt) {
          if (enValue.includes(term) && !value.includes(term))
            reasons.push(`"${term}" must stay untranslated`);
        }
        for (const term of latin) {
          if (
            containsWord(enValue.toLowerCase(), term.toLowerCase()) &&
            !value.toLowerCase().includes(term.toLowerCase())
          ) {
            reasons.push(`"${term}" is kept as "${term}" in this language`);
          }
        }
      }
      if (reasons.length) {
        result.rejected.push({ key, reasons });
        continue;
      }
      const lower = value.toLowerCase();
      for (const word of bannedLists) {
        if (lower.includes(word.toLowerCase())) result.warned.push({ key, word });
      }
      catalogue.set(key, value);
      record.set(key, batch.source[key]!);
      result.merged.push(key);
    }
  }

  for (const key of result.orphans) {
    catalogue.delete(key);
    record.delete(key);
  }
  if (result.merged.length || result.orphans.length) {
    writeJson(cataloguePath(opts.rootDir, locale), buildCatalogue(en, catalogue));
    writeRecord(opts.rootDir, locale, enFlat, record);
  }

  const after = classifyKeys(
    enFlat,
    flattenCatalogue(readJson(cataloguePath(opts.rootDir, locale)) ?? {}),
    readRecord(opts.rootDir, locale),
  );
  result.stillMissing = after.missing.length;
  result.stillStale = after.stale.length;
  result.exitCode = result.rejected.length ? 1 : 0;

  const log = opts.log;
  if (log) {
    log(
      `${locale}: merged ${result.merged.length}, rejected ${result.rejected.length}, warned ${result.warned.length}`,
    );
    for (const r of result.rejected) log(`  REJECTED ${r.key}: ${r.reasons.join(' | ')}`);
    for (const w of result.warned)
      log(`  WARNING  ${w.key}: contains banned word "${w.word}" (fine only for an allowed sense)`);
    log(`  still missing ${result.stillMissing}, still stale ${result.stillStale}`);
    if (result.orphans.length) log(`  dropped orphan keys: ${result.orphans.join(', ')}`);
  }
  return result;
}

// ── status ─────────────────────────────────────────────────────────────────

export interface LocaleStatus {
  locale: string;
  current: number;
  missing: number;
  stale: number;
  untracked: number;
  orphans: number;
  staleKeys: string[];
}

export function listCatalogueLocales(rootDir: string): string[] {
  return readdirSync(join(rootDir, 'messages'))
    .filter((f) => /^[a-z]{2,3}(-[A-Za-z0-9]+)?\.json$/.test(f) && f !== 'en.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function status(opts: CatalogueOptions & { locale?: string; check?: boolean }): {
  locales: LocaleStatus[];
  exitCode: number;
} {
  const { enFlat } = loadEn(opts.rootDir);
  const targets = opts.locale ? [refuseEn(opts.locale)] : listCatalogueLocales(opts.rootDir);
  const locales = targets.map((locale): LocaleStatus => {
    const c = classifyKeys(
      enFlat,
      loadLocale(opts.rootDir, locale),
      readRecord(opts.rootDir, locale),
    );
    return {
      locale,
      current: c.current.length,
      missing: c.missing.length,
      stale: c.stale.length,
      untracked: c.untracked.length,
      orphans: c.orphans.length,
      staleKeys: c.stale,
    };
  });
  for (const s of locales) {
    opts.log?.(
      `${s.locale}: ${s.current} current, ${s.missing} missing, ${s.stale} stale, ${s.untracked} untracked, ${s.orphans} orphan`,
    );
    for (const k of s.staleKeys) opts.log?.(`  stale: ${k}`);
  }
  const failing = locales.some((s) => s.missing || s.stale || s.orphans);
  return { locales, exitCode: opts.check && failing ? 1 : 0 };
}

// ── baseline ───────────────────────────────────────────────────────────────

export function baseline(opts: CatalogueOptions & { locale: string; confirm?: boolean }): {
  recorded: number;
  exitCode: number;
} {
  const locale = refuseEn(opts.locale);
  if (!opts.confirm) {
    opts.log?.(
      `baseline asserts that every untracked ${locale} translation already says what today's English says — a reviewer's judgement. Re-run with --confirm.`,
    );
    return { recorded: 0, exitCode: 1 };
  }
  const { enFlat } = loadEn(opts.rootDir);
  const catalogue = loadLocale(opts.rootDir, locale);
  const record = readRecord(opts.rootDir, locale) ?? new Map<string, string>();
  const { untracked } = classifyKeys(enFlat, catalogue, record);
  for (const key of untracked) record.set(key, enFlat.get(key)!);
  writeRecord(opts.rootDir, locale, enFlat, record);
  opts.log?.(
    `${locale}: recorded the current English as the source of ${untracked.length} untracked key(s)`,
  );
  return { recorded: untracked.length, exitCode: 0 };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function runCatalogueCli(argv: string[], opts: CatalogueOptions): number {
  const [command, ...rest] = argv;
  const log = opts.log ?? ((line: string) => console.log(line));
  const base = { rootDir: opts.rootDir, log };
  try {
    switch (command) {
      case 'extract': {
        const size = option(rest, 'batch-size');
        extract({
          ...base,
          locale: option(rest, 'locale')!,
          batchSize: size ? Number(size) : undefined,
          includeUntracked: flag(rest, 'include-untracked'),
          namespaces: option(rest, 'namespaces')?.split(',').filter(Boolean),
        });
        return 0;
      }
      case 'merge':
        return merge({ ...base, locale: option(rest, 'locale')! }).exitCode;
      case 'status':
        return status({ ...base, locale: option(rest, 'locale'), check: flag(rest, 'check') })
          .exitCode;
      case 'baseline':
        return baseline({
          ...base,
          locale: option(rest, 'locale')!,
          confirm: flag(rest, 'confirm'),
        }).exitCode;
      default:
        log(
          'usage: catalogue.ts <extract|merge|status|baseline> --locale <l> [options] — see scripts/i18n/README.md',
        );
        return 2;
    }
  } catch (err) {
    log(`error: ${(err as Error).message}`);
    return err instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCatalogueCli(process.argv.slice(2), {
    rootDir: resolve(fileURLToPath(new URL('../..', import.meta.url))),
  });
}
