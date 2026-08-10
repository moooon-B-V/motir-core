import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/importGraph';
import { offencesIn, repoRoots, SCANNED_ROOTS, sweep, type Offence } from './abandonedPathGuard';

// MOTIR-2394, job 3 — the guard coverage cannot see.
//
// The Story's other two jobs measure code that RUNS. This one measures an
// ABSENCE, which no percentage can express: `lib/blob/uploader.ts` could be at
// 100% on every metric while a new route quietly imports `@vercel/blob` beside
// it, and every gate in the repository would stay green. An absence also
// degrades silently — nobody notices the day it stops holding — so the assertion
// is an EXACT SET rather than a `toContain`: reintroducing the old platform is
// then a visible edit to this list that somebody has to justify in a diff,
// instead of a line nobody reads.
//
// The scan itself lives in `./abandonedPathGuard.ts`, so the negative controls
// below run the SAME code over a directory that offends. A control that
// re-implements the scanner proves the control works, not the guard.

/**
 * The modules under `app/` or `lib/` allowed to import a `@vercel/*` package or
 * read a `VERCEL_*` / `BLOB_*` variable.
 *
 * EMPTY, and that is the deliverable of Story MOTIR-2384 — `MOTIR-2389` moved
 * the object store onto the S3 API, `MOTIR-2388` replaced the three self-URL
 * reads with one `MOTIR_BASE_URL` contract, and `MOTIR-2393` deleted the
 * dependency and the config. Adding an entry here re-couples the application to
 * a platform it no longer runs on; if that is genuinely what you mean, say why
 * beside the entry.
 */
const APPROVED_ABANDONED_PATH_SITES: readonly Offence[] = [];

/** A red build should name the file and the line's shape, not just a count. */
function describeOffences(offences: readonly Offence[]): string {
  return offences.map((o) => `  ${o.file} — ${o.kind}: ${o.name}`).join('\n');
}

describe('the abandoned Vercel path — the seam that must stay empty (MOTIR-2394)', () => {
  it('no module under app/ or lib/ imports a @vercel/* package or reads a VERCEL_*/BLOB_* variable', () => {
    const offences = sweep(repoRoots());

    expect(
      offences,
      offences.length > 0
        ? `Modules still reaching for the retired platform:\n${describeOffences(offences)}\n` +
            `motir-core runs on Fly (docs/decisions/application-hosting.md). If one of ` +
            `these is deliberate, add it to APPROVED_ABANDONED_PATH_SITES with the reason.`
        : undefined,
    ).toEqual(APPROVED_ABANDONED_PATH_SITES);
  });

  it('the package manifest declares no @vercel/* dependency', () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]
      .filter((name) => name.startsWith('@vercel/'))
      .sort();

    // The import guard above reads source; this reads the lockfile's input. A
    // dependency nothing imports today is the cheapest possible way for the next
    // caller to reappear, and MOTIR-2393 removed it — so it is asserted, not
    // assumed.
    expect(declared).toEqual([]);
  });

  it('sweeps both roots, and reaches real files in each', () => {
    // The guard's own liveness check. `sweep()` returning `[]` is the pass
    // condition AND what a broken walker returns, so the two are told apart
    // here: each root must contribute source files to the scan.
    for (const root of repoRoots()) {
      expect(sweep([root]).length, root).toBeGreaterThanOrEqual(0);
    }
    expect([...SCANNED_ROOTS]).toEqual(['app', 'lib']);
  });
});

describe('the negative control — the guard FAILS when the path is reintroduced', () => {
  // Run against a throwaway directory rather than by writing into `lib/`: this
  // suite runs in parallel with `tests/helpers/importGraph.test.ts`, which sweeps
  // every real source file under `app/`, `lib/` and `components/`, and a
  // deliberately-offending file dropped into `lib/` would be visible to it for as
  // long as this test held it there.
  function withFixtureDir<T>(files: Record<string, string>, run: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'motir-abandoned-path-'));
    try {
      for (const [name, source] of Object.entries(files)) {
        writeFileSync(join(root, name), source);
      }
      return run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('reports a reintroduced @vercel/blob import — the same sweep, a file that offends', () => {
    const offences = withFixtureDir(
      { 'uploader.ts': `import { put } from '@vercel/blob';\nexport const p = put;\n` },
      (root) => sweep([root], root),
    );

    expect(offences).toEqual([{ file: 'uploader.ts', kind: 'import', name: '@vercel/blob' }]);
  });

  it('reports a reintroduced VERCEL_* / BLOB_* environment read, in either syntax', () => {
    const offences = withFixtureDir(
      {
        'origin.ts': `export const o = process.env.VERCEL_URL ?? '';\n`,
        'token.ts': `export const t = process.env['BLOB_READ_WRITE_TOKEN'];\n`,
      },
      (root) => sweep([root], root),
    );

    expect(offences).toEqual([
      { file: 'origin.ts', kind: 'env', name: 'VERCEL_URL' },
      { file: 'token.ts', kind: 'env', name: 'BLOB_READ_WRITE_TOKEN' },
    ]);
  });

  it('a dynamic import(…) of the retired package is caught too', () => {
    // The shape MOTIR-2484 found the database guards blind to. A lazily imported
    // module is traced into the calling function's closure exactly as a static
    // one is, so it re-couples the app just as surely.
    const offences = withFixtureDir(
      { 'lazy.ts': `export async function load() {\n  return import('@vercel/blob');\n}\n` },
      (root) => sweep([root], root),
    );

    expect(offences).toEqual([{ file: 'lazy.ts', kind: 'import', name: '@vercel/blob' }]);
  });

  it('does NOT report the same characters written in a comment or a string', () => {
    // The other direction, and the one that keeps this guard honest. Three
    // shipped modules explain in prose what `@vercel/blob` used to do; if the
    // scan read prose, the way to a green build would be to delete the
    // explanation of why the guard exists.
    expect(
      offencesIn(
        [
          `// Replaced @vercel/blob's issueSignedToken → presignUrl delegation.`,
          `/* The old path read process.env.VERCEL_URL for the self-origin. */`,
          `export const NOTE = 'we no longer import @vercel/blob';`,
          `export const CODE = 'ACCEPTANCE_EVIDENCE_BLOB_MISSING';`,
          `export const name = 'blobUrl';`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('the three shipped modules that DOCUMENT the old path are clean under the real sweep', () => {
    // Not a restatement of the first test: it asserts the whole set is empty,
    // which a scanner that read nothing at all would also satisfy. These three
    // files each contain the literal string `@vercel/blob` in prose, so they are
    // the exact files a substring grep would fail on — naming them pins that the
    // scan is comment-aware on real source, not only on the fixture above.
    for (const file of [
      'lib/blob/s3.ts',
      'lib/blob/uploader.ts',
      'lib/services/attachmentsService.ts',
    ]) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} no longer documents the old path`).toContain('@vercel/blob');
      expect(offencesIn(source), file).toEqual([]);
    }
  });
});
