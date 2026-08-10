import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, specifiersOf, stripComments } from '../helpers/importGraph';

// The scanner behind MOTIR-2394's third job: does any module under `app/` or
// `lib/` still reach for the platform this Story left?
//
// It lives in its OWN module, apart from the test that asserts on it, for one
// reason: the guard's own NEGATIVE CONTROL has to run the identical scan over a
// file that DOES offend, and a control that re-implements the scanner proves
// nothing about the scanner. `tests/hosting/abandonedPath.test.ts` calls
// `sweep()` twice — once at the repository, once at a throwaway directory
// holding a reintroduced import — and the two calls are the same code.
//
// ⚠️ COMMENTS ARE NOT CODE, and here that is load-bearing rather than tidy.
// `lib/blob/s3.ts`, `lib/blob/uploader.ts` and `lib/services/attachmentsService.ts`
// each explain, in prose, what `@vercel/blob` used to do and why the replacement
// is shaped as it is. A guard built on `grep '@vercel/blob'` would fail on those
// docstrings, and the repair for a red build is to DELETE the explanation — so
// the guard would spend its life eating the record of why it exists. The scan
// therefore runs over the comment-stripped text (`tests/helpers/importGraph.ts`,
// the same reader MOTIR-2461 hardened for the database guards), and the control
// asserts BOTH directions: a real import is caught, and the same characters in a
// comment or a string are not.

/** The roots a shipped module can live under. `tests/` is deliberately absent:
 *  a test may name the old platform (a fixture URL, this file's own control). */
export const SCANNED_ROOTS = ['app', 'lib'] as const;

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/**
 * The packages the move retired. A PREFIX, not the one package name: the ask is
 * that nothing pulls the old platform's SDKs back in, and `@vercel/blob` was
 * only the one this repository happened to use.
 */
const FORBIDDEN_PACKAGE_PREFIX = '@vercel/';

/**
 * The environment variables the move retired — the platform's own injected
 * namespace (`VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL`)
 * and its blob store's (`BLOB_READ_WRITE_TOKEN`), including the `NEXT_PUBLIC_`
 * forms a client component would read.
 *
 * ⚠️ Matched on the VARIABLE NAME, never on the raw text. `lib/acceptanceEvidence/
 * errors.ts` exports the code `ACCEPTANCE_EVIDENCE_BLOB_MISSING`, and a scan for
 * the substring `BLOB_` would report it forever — a false positive whose only
 * repair is renaming an unrelated error code.
 */
const FORBIDDEN_ENV_RE = /^(NEXT_PUBLIC_)?(VERCEL_|BLOB_)/;

/** `process.env.NAME`, `process.env['NAME']`, `process.env["NAME"]`. */
const ENV_READ_RE = /process\s*\.\s*env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

export interface Offence {
  /** Repo-relative (or root-relative) path of the offending module. */
  file: string;
  /** `import` for a package specifier, `env` for a variable read. */
  kind: 'import' | 'env';
  /** The specifier or variable name that offends. */
  name: string;
}

/** Every `.ts`/`.tsx` file under `root`, recursively. */
export function sourceFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/** The offences in ONE file's source text. Exported for the control's
 *  direction-by-direction assertions. */
export function offencesIn(source: string): Array<Omit<Offence, 'file'>> {
  const found: Array<Omit<Offence, 'file'>> = [];

  for (const specifier of specifiersOf(source)) {
    if (specifier.startsWith(FORBIDDEN_PACKAGE_PREFIX)) {
      found.push({ kind: 'import', name: specifier });
    }
  }

  // `specifiersOf` already ignores comments; the env scan has to strip them
  // itself, and a STRING is not stripped — `'process.env.VERCEL_URL'` written
  // inside a string literal is text about a read, not a read. It is left in on
  // purpose: over-reporting fails a build someone reads, under-reporting ships
  // the coupling back with the guard green, and the two directions are not
  // symmetric (the same reasoning `tests/helpers/importGraph.ts` records).
  for (const match of stripComments(source).matchAll(ENV_READ_RE)) {
    const name = match[1] ?? match[2] ?? '';
    if (FORBIDDEN_ENV_RE.test(name)) found.push({ kind: 'env', name });
  }

  return found;
}

/**
 * Sweep every source file under `roots` (absolute paths) and return the
 * offences, sorted, with paths relative to `base`.
 */
export function sweep(roots: readonly string[], base: string = REPO_ROOT): Offence[] {
  const offences: Offence[] = [];
  for (const root of roots) {
    for (const file of sourceFilesUnder(root)) {
      const rel = relative(base, file).split('\\').join('/');
      for (const offence of offencesIn(readFileSync(file, 'utf8'))) {
        offences.push({ file: rel, ...offence });
      }
    }
  }
  return offences.sort((a, b) =>
    `${a.file}${a.kind}${a.name}`.localeCompare(`${b.file}${b.kind}${b.name}`),
  );
}

/** The repository's own roots, absolute. */
export function repoRoots(): string[] {
  return SCANNED_ROOTS.map((root) => join(REPO_ROOT, root));
}
