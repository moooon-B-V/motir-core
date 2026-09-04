import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/importGraph';
import {
  offencesIn,
  repoRoots,
  SCANNED_ROOTS,
  sourceFilesUnder,
  sweep,
  type Offence,
} from './contentLegalReaderGuard';

// THE ABSENCE GUARD (Story MOTIR-4101 · Subtask MOTIR-4104).
//
// MOTIR-4103 deleted `content/legal/` and `app/(public)/legal/` from this
// repository. This file is the half that says so in a way a machine can keep.
//
// ⚠️ WHY AN ABSENCE NEEDS ITS OWN GUARD, AND WHY COVERAGE CANNOT BE IT. Every
// suite under `tests/legal/` measures code that RUNS: the parse, the materiality
// rule, the rows, the rendered row. All of them could sit at 100% on every axis
// while `lib/legal/documents.ts` also `readdirSync`'d a directory beside them,
// and every gate in the repository would stay green. MOTIR-4014 drove the whole
// manifest wire while `content/legal/` was still on disk — a manifest that
// returns documents returns them whether or not something else is also reading
// files, so that run is silent about this property by construction.
//
// ⚠️ AND THE ASSERTION IS AN EXACT SET RATHER THAN A `toContain`, because an
// absence degrades silently: nobody notices the day it stops holding. Putting a
// reader back is then a visible edit to a list somebody has to justify in a
// diff, instead of a line nobody reads.
//
// The scan lives in `./contentLegalReaderGuard.ts` so the controls at the bottom
// run the SAME code over a directory that offends. That is not a nicety here:
// the subject of this guard is GONE, so a green run and a scan that read nothing
// at all produce the identical result, and only a red obtained from the same
// code tells them apart.

/**
 * The modules allowed to reach the filesystem from `lib/legal/`, or to name the
 * retired document path in shipped code.
 *
 * EMPTY, and that is the deliverable of Story MOTIR-4101 — MOTIR-4007 swapped
 * the source to `MOTIR_LEGAL_DOCUMENTS` and MOTIR-4103 deleted the directory it
 * replaced. Adding an entry here re-introduces a second source of moooon B.V.'s
 * contract text beside the configured one; if that is genuinely what you mean,
 * say why beside the entry.
 */
const APPROVED_CONTENT_LEGAL_READERS: readonly Offence[] = [];

/**
 * What `content/` holds — the POPULATION, as a set.
 *
 * ⚠️ A SET RATHER THAN A MAXIMUM, and the difference is the whole point of
 * writing it this way. "`content/legal/terms.md` is gone" is satisfied by a tree
 * that still holds the other six documents; "`content/` holds exactly these
 * files" is not satisfiable by anything except the truth. So the assertion is an
 * equality against this constant, and a file arriving under `content/` fails
 * here by NAME — which is correct, because the CI `content/*` arm that
 * MOTIR-4103 deliberately kept exists for exactly that arrival and somebody
 * should read this list when it happens.
 */
const EXPECTED_CONTENT_POPULATION: readonly string[] = [];

/** A red build should name the file and the line's shape, not just a count. */
function describeOffences(offences: readonly Offence[]): string {
  return offences.map((o) => `  ${o.file} — ${o.kind}: ${o.name}`).join('\n');
}

/** Tracked paths under `pathspec` at a git REF — never a walk of a working tree. */
function trackedAtRef(ref: string, pathspec: string): string[] {
  const out = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', pathspec], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter((l) => l.length > 0);
}

/** Tracked paths under `pathspec` in the INDEX. */
function trackedInIndex(pathspec: string): string[] {
  const out = execFileSync('git', ['ls-files', '--', pathspec], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\n').filter((l) => l.length > 0);
}

describe('nothing in this repository reads content/legal/ any more (MOTIR-4104)', () => {
  it('no shipped module imports fs under lib/legal/, calls a read there, or names the retired path', () => {
    const offences = sweep(repoRoots());

    expect(
      offences,
      offences.length > 0
        ? `Shipped modules still reaching for the deleted document source:\n` +
            `${describeOffences(offences)}\n` +
            `The documents are served from motir.co and this application reads ` +
            `MOTIR_LEGAL_DOCUMENTS (lib/legal/documents.ts; ` +
            `docs/decisions/public-surface-hosts.md AMENDMENT 2 §C). If one of these is ` +
            `deliberate, add it to APPROVED_CONTENT_LEGAL_READERS with the reason.`
        : undefined,
    ).toEqual(APPROVED_CONTENT_LEGAL_READERS);
  });

  it('sweeps all three roots, and reaches real files in each — the guard is not vacuous', () => {
    // ⚠️ THE LIVENESS CHECK, and on a guard whose pass condition is `[]` it is not
    // optional. A walker that silently reached nothing returns exactly what a
    // clean repository returns. So each root must contribute source files to the
    // scan, and the root list itself is pinned: dropping `components` from
    // `SCANNED_ROOTS` would turn a third of this guard off with no test failing.
    expect([...SCANNED_ROOTS]).toEqual(['app', 'lib', 'components']);
    for (const root of repoRoots()) {
      expect(sourceFilesUnder(root).length, `${root} contributed no source files`).toBeGreaterThan(
        0,
      );
    }
    // And the family the `fs` clause is scoped to is itself non-empty: a
    // `LEGAL_MODULE_RE` that matched nothing would leave two of the three clauses
    // inert while the whole suite stayed green.
    const legalModules = sourceFilesUnder(join(REPO_ROOT, 'lib', 'legal'));
    expect(legalModules.length, 'lib/legal/ has no source files').toBeGreaterThan(0);
  });

  it('content/ holds exactly the expected population — asserted as a SET, at a ref', () => {
    // ⚠️ MEASURED ON A REF, NEVER WITH `find` / `ls` OVER A WORKING TREE somebody
    // is mid-edit in. Both readings are asserted because they answer different
    // questions: `ls-tree HEAD` is what the last commit holds, and `ls-files` is
    // what the INDEX holds — so a file staged but not yet committed fails here
    // rather than on somebody else's branch a day later.
    expect(trackedAtRef('HEAD', 'content'), 'git ls-tree -r HEAD -- content').toEqual(
      EXPECTED_CONTENT_POPULATION,
    );
    expect(trackedInIndex('content'), 'git ls-files -- content').toEqual(
      EXPECTED_CONTENT_POPULATION,
    );
  });

  it('the abandoned public route group is gone from the tree, not merely unreferenced', () => {
    // The other half of MOTIR-4103's deletion. A route that renders nothing is
    // still a live invitation to re-adopt, and `app/(public)/legal/` is the one
    // the seven documents were served from.
    expect(trackedAtRef('HEAD', 'app/(public)/legal')).toEqual([]);
    expect(trackedInIndex('app/(public)/legal')).toEqual([]);
  });
});

describe('the negative control — the guard FAILS when a reader is reintroduced', () => {
  // Run against a throwaway directory rather than by writing into `lib/`: this
  // suite runs beside `tests/helpers/importGraph.test.ts`, which sweeps every real
  // source file under `app/`, `lib/` and `components/`, and a deliberately
  // offending file dropped into `lib/legal/` would be visible to it for as long
  // as this test held it there.
  function withFixtureDir<T>(files: Record<string, string>, run: (root: string) => T): T {
    const root = mkdtempSync(join(tmpdir(), 'motir-content-legal-'));
    try {
      for (const [name, source] of Object.entries(files)) {
        const full = join(root, name);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, source);
      }
      return run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('reports a reintroduced node:fs import under lib/legal/ — the same sweep, a file that offends', () => {
    const offences = withFixtureDir(
      {
        'lib/legal/documents.ts':
          `import { readdirSync } from 'node:fs';\n` +
          `export const slugs = () => readdirSync('somewhere');\n`,
      },
      (root) => sweep([root], root),
    );

    expect(offences).toEqual([
      { file: 'lib/legal/documents.ts', kind: 'fs-call', name: 'readdirSync' },
      { file: 'lib/legal/documents.ts', kind: 'fs-import', name: 'node:fs' },
    ]);
  });

  it('reports a read reached WITHOUT an import — a namespace import, and a helper', () => {
    // ⚠️ The two shapes the specifier clause alone is blind to, and the reason
    // both clauses exist. A namespace import names `node:fs` but no binding a
    // specifier check would recognise as a read; a helper re-exported from
    // elsewhere names no filesystem specifier at all.
    const offences = withFixtureDir(
      {
        'lib/legal/viaNamespace.ts':
          `import * as fs from 'node:fs';\n` +
          `export const read = () => fs.readFileSync('x', 'utf8');\n`,
        'lib/legal/viaHelper.ts':
          `import { readFileSync } from '../../tests/helpers/notReallyFs';\n` +
          `export const read = () => readFileSync('x');\n`,
      },
      (root) => sweep([root], root),
    );

    expect(offences).toEqual([
      { file: 'lib/legal/viaHelper.ts', kind: 'fs-call', name: 'readFileSync' },
      { file: 'lib/legal/viaNamespace.ts', kind: 'fs-call', name: 'readFileSync' },
      { file: 'lib/legal/viaNamespace.ts', kind: 'fs-import', name: 'node:fs' },
    ]);
  });

  it('reports the retired path named in shipped code ANYWHERE in the scanned roots', () => {
    // Not scoped to `lib/legal/`: a route, a component or a service that can
    // still resolve `content/legal` is a module that can still serve moooon
    // B.V.'s contract text off this host, wherever it sits.
    const offences = withFixtureDir(
      {
        'app/page.tsx': `export const P = 'content/legal/terms.md';\n`,
        'components/Foo.tsx': `export const glob = ['content/legal/*.md'];\n`,
      },
      (root) => sweep([root], root),
    );

    expect(offences).toEqual([
      { file: 'app/page.tsx', kind: 'content-path', name: 'content/legal' },
      { file: 'components/Foo.tsx', kind: 'content-path', name: 'content/legal' },
    ]);
  });

  it('does NOT report the same characters written in a comment', () => {
    // The other direction, and the one that keeps this guard honest.
    // `lib/legal/documents.ts` and `lib/legal/consent.ts` each explain in prose
    // what the directory used to be; if the scan read prose, the way to a green
    // build would be to delete the explanation of why the guard exists.
    expect(
      offencesIn(
        'lib/legal/documents.ts',
        [
          `// This module used to readdirSync content/legal/. Those documents are`,
          `/* the readFileSync of content/legal/terms.md is gone. */`,
          `export const ENV = 'MOTIR_LEGAL_DOCUMENTS';`,
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('does NOT report an fs read from a module OUTSIDE lib/legal/', () => {
    // The scope, asserted rather than assumed. Shipped modules read files
    // legitimately all over `lib/`; the property this guard holds is about the
    // legal document family, not about the filesystem.
    expect(
      offencesIn('lib/blob/s3.ts', `import { readFileSync } from 'node:fs';\nreadFileSync('x');\n`),
    ).toEqual([]);
  });

  it('the two shipped modules that DOCUMENT the old path are clean under the real sweep', () => {
    // Not a restatement of the first test, which asserts the whole set is empty —
    // something a scanner that read nothing would also satisfy. These two files
    // each contain the literal `content/legal` in prose, so they are the exact
    // files a substring grep would fail on. Naming them pins that the scan is
    // comment-aware on REAL source, not only on the fixtures above.
    for (const file of ['lib/legal/documents.ts', 'lib/legal/consent.ts']) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} no longer documents the old source`).toContain('content/legal');
      expect(offencesIn(file, source), file).toEqual([]);
    }
  });
});
