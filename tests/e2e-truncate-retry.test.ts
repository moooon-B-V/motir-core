import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3739 — every TRUNCATE the E2E lane issues goes through the ONE door that
// retries on a Postgres deadlock (`40P01`).
//
// ── The failure this exists to end ──────────────────────────────────────────
// `tests/e2e/_helpers/db-reset.ts` has retried on `40P01` since the deadlock was
// first diagnosed, and its comment names the cause: this lane deliberately runs a
// REAL job worker beside the specs, so a TRUNCATE of `job_queue` / `job_event` /
// `job_step` collides with a worker that is claiming rows out of them. The retry
// was written inside `resetDatabase`'s own closure, so it reached exactly one
// call — and the `beforeEach` block above it read as uniformly guarded:
//
//   await resetDatabase();      // retried
//   await truncateJobRuns();    // NOT retried
//   await adminDb.$executeRawUnsafe('TRUNCATE TABLE "job_event", …');  // NOT retried
//
// Eight specs reached a truncate without the retry that way (five with the raw
// statement, three with the bare helper), and the raw one deadlocked on
// motir-core#2398 — a pull request whose diff was two Markdown files and a
// comment, and whose author had no reason to know this lane runs a worker.
//
// ── Why a source scan, and why it guards an ABSENCE ─────────────────────────
// There is no runtime object to assert on: a truncate is a string literal or a
// helper call in a suite-local `beforeEach`, and the failure mode is that the
// NEXT one is written the same way. A guard keyed on a wrong thing being present
// catches the careless; this one is keyed on the right thing being reached, so it
// also catches the unaware — which is the larger population, and the one that
// wrote all eight sites. Same instrument as
// `tests/truncate-lock-order.test.ts`, which already adjudicates truncate
// behaviour in this repository by reading source.
//
// ⚠️ THE RETRY IS A MASK, NOT A CURE, and that is a deliberate trade rather than
// an oversight. MOTIR-3066 traced the VITEST lane's `40P01` to an abandoned
// `Promise.all` arm holding a transaction open, and was explicit that making
// every truncate helper agree on an order cannot fix the class. Here the
// contending party is a live worker the lane starts on purpose, so the collision
// is genuinely transient and a bounded wait is the right answer. What is not
// acceptable is one truncate carrying that reasoning and its neighbour not.
//
// ── Lane ────────────────────────────────────────────────────────────────────
// This stays in the sharded run rather than joining `STRUCTURAL_GUARD_SPECS`: it
// walks ONE directory (`tests/e2e`, ~240 files) rather than the source tree, so
// it is not the whole-tree profile that lane exists to move — the same place its
// sibling `tests/truncate-lock-order.test.ts` sits.

const ROOT = join(__dirname, '..');
const E2E_DIR = join(ROOT, 'tests/e2e');

/** The one file allowed to name a truncate — the door the retry lives behind. */
const DOOR = 'tests/e2e/_helpers/db-reset.ts';
const RETRY = 'withTruncateDeadlockRetry';

/**
 * The truncate helpers, DERIVED from `tests/helpers/db.ts` rather than listed.
 * A helper added there is in scope the day it is written, and one that is renamed
 * breaks this guard loudly instead of disabling it silently.
 */
function truncateHelperNames(): string[] {
  const source = readFileSync(join(ROOT, 'tests/helpers/db.ts'), 'utf8');
  return [...source.matchAll(/^export async function (truncate\w+)/gm)].map((m) => m[1]!);
}

/**
 * Comments are stripped before anything is matched. `db-reset.ts`'s own header
 * discusses `truncateAuthTables` and "TRUNCATE deadlocking" in prose, and a
 * substring check over prose is exactly how a guard reports the wrong file — or,
 * worse, reads a comment as compliance.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** A raw `TRUNCATE TABLE "tbl", …` statement — the quoted table list, as `truncate-lock-order` reads it. */
const RAW_TRUNCATE = /TRUNCATE\s+TABLE\s+"[a-z_]+"/gi;

interface TruncateRef {
  /** `raw` — a TRUNCATE statement written out; `helper` — a `tests/helpers/db.ts` truncate. */
  shape: 'raw' | 'helper';
  name: string;
  index: number;
}

/**
 * Every way a file reaches a truncate. BOTH shapes, because they are the two
 * that actually occurred: five specs wrote the statement, three called the
 * helper, and a guard that saw only one of them would have reported the fix as
 * complete with three sites still unprotected.
 *
 * Import statements are excluded — importing the name is not issuing the
 * truncate, and the door imports both.
 */
export function truncateRefsIn(source: string, helpers: readonly string[]): TruncateRef[] {
  const src = stripComments(source).replace(/^import[\s\S]*?from\s+'[^']+';/gm, (m) =>
    ' '.repeat(m.length),
  );
  const refs: TruncateRef[] = [];
  RAW_TRUNCATE.lastIndex = 0;
  for (const m of src.matchAll(RAW_TRUNCATE)) {
    refs.push({ shape: 'raw', name: m[0], index: m.index });
  }
  for (const name of helpers) {
    for (const m of src.matchAll(new RegExp(`\\b${name}\\b`, 'g'))) {
      refs.push({ shape: 'helper', name, index: m.index });
    }
  }
  return refs.sort((a, b) => a.index - b.index);
}

/** The helper references this source hands to the retry wrapper, by index. */
function guardedIndices(source: string): Set<number> {
  const src = stripComments(source);
  const out = new Set<number>();
  // Both call shapes: the bare reference, and an arrow wrapping it.
  for (const m of src.matchAll(
    new RegExp(`${RETRY}\\(\\s*(?:\\(\\)\\s*=>\\s*)?([A-Za-z_$][\\w$]*)`, 'g'),
  )) {
    out.add(m.index + m[0].length - m[1]!.length);
  }
  return out;
}

function e2eFiles(dir = E2E_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) e2eFiles(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

describe('every E2E truncate runs under the 40P01 retry (MOTIR-3739)', () => {
  const HELPERS = truncateHelperNames();
  const FILES = e2eFiles();

  it('the scan sees the E2E tree and the helper set at all', () => {
    // A source-scanning guard whose walk or whose derived name set has quietly
    // gone empty passes every assertion below and reads exactly like a clean
    // repository. Both floors, because either one going to zero is enough.
    expect(FILES.length).toBeGreaterThan(100);
    expect(HELPERS).toContain('truncateJobRuns');
    expect(HELPERS).toContain('truncateAuthTables');
  });

  it('the detector fires on BOTH shapes, and not on prose — demonstrated, not assumed', () => {
    // The two shapes are the two that occurred. Asserting them against fixtures
    // is what stops this file passing because a regex stopped matching, and the
    // negative case is the one the door's own header would otherwise trip.
    const raw = 'await adminDb.$executeRawUnsafe(\'TRUNCATE TABLE "job_queue" CASCADE\');';
    expect(truncateRefsIn(raw, HELPERS).map((r) => r.shape)).toEqual(['raw']);

    const call = 'await truncateJobRuns();';
    expect(truncateRefsIn(call, HELPERS).map((r) => r.shape)).toEqual(['helper']);

    const prose = [
      '// Retries on Postgres deadlock (40P01): TRUNCATE TABLE "job_queue" deadlocking',
      '// against an in-flight transaction — see truncateJobRuns for the tables.',
      '/* truncateAuthTables is called through the retry below. */',
    ].join('\n');
    expect(truncateRefsIn(prose, HELPERS)).toEqual([]);

    const imported = "import { truncateJobRuns } from '@/tests/helpers/db';";
    expect(truncateRefsIn(imported, HELPERS)).toEqual([]);
  });

  it('no spec under tests/e2e/** reaches a truncate itself', () => {
    const offenders = FILES.flatMap((file) => {
      if (file === DOOR) return [];
      const source = readFileSync(join(ROOT, file), 'utf8');
      return truncateRefsIn(source, HELPERS).map(
        (ref) => `${file} — ${ref.shape === 'raw' ? 'a raw TRUNCATE statement' : ref.name}`,
      );
    });

    expect(
      offenders,
      `These reach a TRUNCATE without the \`${RETRY}\` wrapper. The E2E lane runs a live job ` +
        `worker beside the specs, so an unprotected truncate deadlocks (\`40P01\`) against it and ` +
        `reds a pull request that has nothing to do with this spec.\n\n` +
        `Call a door on \`${DOOR}\` instead — \`resetDatabase()\` or \`truncateJobTables()\` — or ` +
        `add one there, wrapping the new \`tests/helpers/db.ts\` helper in \`${RETRY}\`. Do not ` +
        `write the statement out: \`tests/truncate-lock-order.test.ts\` and the raw-statement ` +
        `ratchet both adjudicate it where it lives.\n\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the door itself still routes every truncate through the retry', () => {
    // The mirror failure: the specs are clean and the wrapper has been unpicked,
    // which the check above cannot see because it never reads the door.
    const source = readFileSync(join(ROOT, DOOR), 'utf8');
    // ⚠️ Asserted against the STRIPPED source, because this file's header
    // discusses `40P01` at length — a `toContain` over the raw text is satisfied
    // by the comment that explains the retry, so it would stay green over a
    // predicate that had lost the SQLSTATE. (Found by mutating this guard: the
    // raw-text form passed with the predicate narrowed to /deadlock/i.)
    const code = stripComments(source);

    expect(code, `${DOOR} no longer exports ${RETRY}`).toMatch(
      new RegExp(`export async function ${RETRY}\\b`),
    );
    expect(code, `${RETRY} no longer keys on the deadlock SQLSTATE`).toContain('40P01');
    expect(code, `${RETRY} no longer bounds its attempts — an unbounded retry is a hang`).toMatch(
      /attempt >= \d+/,
    );

    const guarded = guardedIndices(source);
    const unguarded = truncateRefsIn(source, HELPERS)
      .filter((ref) => !guarded.has(ref.index))
      .map((ref) => (ref.shape === 'raw' ? 'a raw TRUNCATE statement' : ref.name));

    expect(
      unguarded,
      `${DOOR} reaches these truncates outside \`${RETRY}\`. Every door in this file wraps its ` +
        `helper — that is the whole reason the wrapper was lifted out of \`resetDatabase\`'s ` +
        `closure (MOTIR-3739).\n\n${unguarded.join('\n')}`,
    ).toEqual([]);
  });
});
