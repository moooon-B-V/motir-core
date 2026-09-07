import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { topLevelSegments } from '../helpers/twoFactorGuardSweeps';

// MOTIR-3726's DERIVED half, split out of `tests/seo/robots.test.ts` so it can
// live in the structural-guard lane (MOTIR-3144).
//
// ── Why it is a separate file ───────────────────────────────────────────────
// `topLevelSegments` recurses through `app/(authed)` and `app/(onboarding)`,
// reading every nested route group and asking each directory
// whether it serves a page — whole-tree filesystem work, on the cost profile the
// lane exists to keep out of the sharded database job. Importing it makes a spec
// a lane CANDIDATE, and `tests/ci-structural-guards-lane.test.ts` says so by
// name. The rest of the robots suite tests the POLICY, imports it, and belongs
// in the sharded run where its coverage is counted; those two halves cannot be
// one file (the same split `twoFactorPredicateOneImplementation` was made for).
//
// ── Why it READS the authored list instead of importing it ──────────────────
// The lane's purity rule: no member reaches `lib/`, `app/` or `components/`,
// because the lane runs without `--coverage` and an import from there would
// carry a file out of the merged report. So the authored segments are read from
// the SOURCE, the way every other lane member reads the tree it guards — and the
// extraction asserts itself non-vacuous first, because a guard that silently
// parses nothing passes for the wrong reason (the trap MOTIR-2815 hit).
//
// ⚠️ WHAT IT PROTECTS. `proxy-matcher.test.ts` exists because a hand-kept list
// drifted: sixteen segments served, three listed. A signed-in segment missing
// from `SIGNED_IN_SEGMENTS` is a signed-in surface offered to crawlers; a
// segment listed that nothing serves is a `Disallow` that will one day block a
// public page a future author puts at that path. Both directions are asserted.

const ROOT = process.cwd();
const APP = join(ROOT, 'app');
const POLICY = join(ROOT, 'lib', 'robotsPolicy.ts');
// ⚠️ `(planning)` was a third until MOTIR-4732 retired the route group. `planning`
// is still a SERVED signed-in segment and still `Disallow`ed — the forward for
// old links lives at `app/(authed)/planning/` now, so the sweep finds it under
// `(authed)` and the policy list below needs no change.
const SIGNED_IN_GROUPS = ['(authed)', '(onboarding)'] as const;

/** The `SIGNED_IN_SEGMENTS` array literal, read out of the policy's source. */
function authoredSegments(): string[] {
  const source = readFileSync(POLICY, 'utf8');
  const declaration = /export const SIGNED_IN_SEGMENTS = \[([^\]]*)\]/.exec(source);
  expect(
    declaration,
    'SIGNED_IN_SEGMENTS is not declared as an array literal in lib/robotsPolicy.ts',
  ).not.toBeNull();
  return [...(declaration?.[1] ?? '').matchAll(/'([^']+)'/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

/** Every top-level segment the signed-in route groups actually serve. */
function servedSegments(): string[] {
  const served = new Set<string>();
  for (const group of SIGNED_IN_GROUPS) {
    for (const segment of topLevelSegments(APP, group)) served.add(segment);
  }
  return [...served].sort();
}

describe('robots.txt disallows every signed-in segment the filesystem serves', () => {
  it('reads a NON-EMPTY authored list — the extraction is asserted before it is trusted', () => {
    const authored = authoredSegments();
    // Ten is well under the eighteen shipped and well over anything a broken
    // regex returns. If the declaration is ever reformatted past this parse, the
    // guard goes red here rather than passing on an empty set.
    expect(authored.length).toBeGreaterThanOrEqual(10);
    expect(new Set(authored).size, 'a segment is listed twice').toBe(authored.length);
  });

  it('names every segment the signed-in groups serve', () => {
    const authored = new Set(authoredSegments());
    expect(servedSegments().filter((s) => !authored.has(s))).toEqual([]);
  });

  it('names NOTHING the filesystem does not serve', () => {
    const served = new Set(servedSegments());
    expect(authoredSegments().filter((s) => !served.has(s))).toEqual([]);
  });
});
