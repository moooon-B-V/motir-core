import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ADJUDICATED_UNBOUND_FILES,
  countByVerdict,
  preAuthKeys,
  repositoryIndex,
  scanTestCallSites,
  type TestCallSite,
} from './testCallSiteScan';

// The TEST call-site guard (MOTIR-2817) — the shared answer eleven batch cards
// read instead of each re-deriving it by eye across ~50 lines.
//
// Same division of labour as the MOTIR-2784 singleton-read guard: the machine
// enumerates and classifies, the ratchets record where the work stands, and a
// change that quietly re-opens settled ground is a red build rather than a
// reviewer's job to notice.
//
// ⚠️ WHY THE NUMBERS BELOW ARE NOT THE STORY'S. MOTIR-2797's body was written
// against a throwaway grep that reported 876 call sites — 577 in-scope, 157
// out-of-scope, 142 needs-binding-first. This classifier is that measurement's
// replacement, and MOTIR-2817's acceptance criteria say so explicitly: if the
// real numbers differ, THE CLASSIFIER WINS and the card updates the story body.
// They differ for two reasons, both expected:
//
//   • The story measured BEFORE MOTIR-2755 merged. The twenty fixture batches
//     plus MOTIR-2774 / 2777 / 2789 bound a large number of these very reads on
//     the way past, which is why `already-bound` is now the second-largest
//     population at 352. Those sites left `in-scope` by being FIXED.
//   • A grep counts lines; this counts CALLS, and it sees the ones a grep cannot
//     (a call wrapped across lines) while refusing to guess at the ones a grep
//     waves through (a method it cannot find, which lands in `unclassifiable`
//     and fails the build rather than defaulting to in-scope).
//
// The batch cards' per-directory counts are therefore also stale and are
// corrected from this run's per-directory report, not from the old table.

const FIXTURE = path.join(process.cwd(), 'tests/rls/__fixtures__/testCallSites');

/**
 * The in-scope ratchet — the work MOTIR-2797 has left.
 *
 * ⚠️ This number may only ever go DOWN, and each batch lowers it BY SUBTRACTION
 * from whatever the line then reads — never by restating an absolute. Twelve
 * cards edit this line; a merge conflict here is EXPECTED and is resolved by
 * applying BOTH subtractions. Restating an absolute silently discards a sibling
 * batch's progress, which is invisible in the diff and looks exactly like
 * agreement.
 */
// 375 - 39 (MOTIR-2834, tests/integration/sprints) = 336
// 336 - 53 (MOTIR-2835, tests/integration/work-items) = 283
const IN_SCOPE_CEILING = 283;

/**
 * The do-not-touch ratchet, and the load-bearing half of this file.
 *
 * `not-gated` and `pre-auth` sites are CORRECT unbound: no policy applies to the
 * first, and the second was adjudicated deliberately actorless by MOTIR-2784 —
 * "fixing" one contradicts a recorded decision and is indistinguishable from
 * real work in a diff. This counts the out-of-scope sites that pass no `tx`, so
 * a batch that helpfully binds one fails the build instead of passing review.
 *
 * ⚠️ It may only ever go UP or stay. It is NOT the count of out-of-scope sites
 * (244) — 95 of those legitimately pass a `tx` already, because a write method
 * requires one whether or not its model is gated. The verdict alone cannot catch
 * this: a `not-gated` call handed a `tx` is still `not-gated`, which is why the
 * scanner records `bound` separately from the verdict.
 */
const UNTOUCHED_OUT_OF_SCOPE_FLOOR = 149;

const outOfScope = (s: TestCallSite): boolean =>
  s.verdict === 'not-gated' || s.verdict === 'pre-auth';

describe('the test call-site classifier rules on every shape', () => {
  it('classifies all five verdicts on a fixture built to contain one of each', () => {
    const { sites } = scanTestCallSites(FIXTURE);
    const seen = sites.map((s) => `${s.method}:${s.verdict}`).sort();

    expect(seen).toEqual(
      [
        'countAllUnsafe:pre-auth',
        'findGlobalSettings:not-gated',
        'findGlobalSettingsBindable:not-gated',
        'findGlobalSettingsBindable:not-gated',
        'findWidgets:already-bound',
        'findWidgets:in-scope',
        'findWidgets:in-scope',
        'findWidgetsUnbindable:needs-binding-first',
        'findWidgetsWrapped:already-bound',
        'findWidgetsWrapped:in-scope',
        'rawWidgetCount:in-scope',
      ].sort(),
    );
    expect(countByVerdict(sites)).toEqual({
      'in-scope': 4,
      'not-gated': 3,
      'pre-auth': 1,
      'needs-binding-first': 1,
      'already-bound': 2,
      'adjudicated-unbound': 0,
    });
  });

  it('DETECTS an out-of-scope call site that has been given a `tx`', () => {
    // The load-bearing case, proven on the fixture rather than only pinned as a
    // count over the real suite. The fixture calls `findGlobalSettingsBindable`
    // twice — once unbound (correct) and once bound (the violation a batch would
    // introduce by "helpfully" fixing a leave-alone site).
    //
    // Both calls keep the verdict `not-gated`, which is exactly why the verdict
    // cannot be the signal: only `bound` separates them. If this ever stops
    // distinguishing the two, the floor assertion over the real suite silently
    // stops protecting anything, because every count would still add up.
    const { sites } = scanTestCallSites(FIXTURE);
    const both = sites.filter((s) => s.method === 'findGlobalSettingsBindable');

    expect(both.map((s) => s.verdict)).toEqual(['not-gated', 'not-gated']);
    expect(both.map((s) => s.bound).sort()).toEqual([false, true]);

    // And the metric the real-suite floor is computed from moves by exactly one.
    // Three, not two: `outOfScope` spans `not-gated` AND `pre-auth`, so the
    // unbound `countAllUnsafe` counts alongside the two `globalSetting` reads.
    const untouched = sites.filter((s) => outOfScope(s) && !s.bound);
    expect(untouched.map((s) => s.method).sort()).toEqual([
      'countAllUnsafe',
      'findGlobalSettings',
      'findGlobalSettingsBindable',
    ]);
  });

  it('a shape it cannot rule on fails LOUDLY instead of defaulting to in-scope', () => {
    const { unclassifiable } = scanTestCallSites(FIXTURE);

    // The fixture calls `ghostRepository.vanished`, which no repository defines.
    // Defaulting it to `in-scope` would send a batch to bind something that does
    // not exist; dropping it silently would hide a renamed method from every
    // future sweep. It must surface.
    expect(unclassifiable).toHaveLength(1);
    expect(unclassifiable[0]?.callee).toBe('ghostRepository.vanished');
  });

  it('an ADJUDICATED pre-auth verdict beats the shape', () => {
    const { sites } = scanTestCallSites(FIXTURE);
    const preAuth = sites.filter((s) => s.verdict === 'pre-auth');

    // `countAllUnsafe` is gated and bindable and passes no `tx` — by shape alone
    // it is indistinguishable from in-scope work. Only the guard's VERDICTS map
    // says otherwise, and that adjudication has to win.
    expect(preAuth.map((s) => s.method)).toEqual(['countAllUnsafe']);
    expect([...preAuthKeys(FIXTURE)]).toEqual(['fixtureRepository.ts#countAllUnsafe']);
  });

  it('reads a MULTI-LINE `tx?` signature — the regression that cost ~60 sites', () => {
    // A single-line regex reports `countBacklog` as unbindable because its `tx?`
    // sits on its own line, which moved ~60 sites into `needs-binding-first` and
    // inflated the first measurement of this story. Pinned as the specific
    // method, not as a general claim, because that is what actually regressed.
    const backlog = repositoryIndex().get('workItemRepository.countBacklog');
    expect(backlog).toBeDefined();
    expect(backlog?.txIndex).toBe(4);

    const wrapped = repositoryIndex(FIXTURE).get('fixtureRepository.findWidgetsWrapped');
    expect(wrapped?.txIndex).toBe(2);
  });

  it('an explicit `undefined` in the tx slot binds NOTHING', () => {
    const { sites } = scanTestCallSites(FIXTURE);
    const explicitUndefined = sites.filter((s) => s.method === 'findWidgets');

    // `findWidgets(ws, undefined)` type-checks and looks bound at a glance. Two
    // of the three calls are unbound, and both must be offered to a batch.
    expect(explicitUndefined.filter((s) => s.verdict === 'in-scope')).toHaveLength(2);
    expect(explicitUndefined.filter((s) => s.bound)).toHaveLength(1);
  });
});

describe('the ratchets over the real test suite', () => {
  it('the in-scope count only ever falls', () => {
    const { sites } = scanTestCallSites();
    const inScope = sites.filter((s) => s.verdict === 'in-scope').length;

    expect(
      inScope,
      `in-scope test call sites rose to ${inScope} (ceiling ${IN_SCOPE_CEILING}).\n` +
        `If you BOUND sites, LOWER the ceiling BY THE NUMBER YOU FIXED — subtract ` +
        `from whatever the line reads when you get there, do NOT restate an ` +
        `absolute. Twelve cards edit it; a conflict is expected and both ` +
        `subtractions apply.\n` +
        `If you ADDED an unbound gated call, bind it instead of raising this.`,
    ).toBeLessThanOrEqual(IN_SCOPE_CEILING);
  });

  it('no out-of-scope call site has been given a `tx`', () => {
    const { sites } = scanTestCallSites();
    const untouched = sites.filter((s) => outOfScope(s) && !s.bound);

    expect(
      untouched.length,
      `${UNTOUCHED_OUT_OF_SCOPE_FLOOR - untouched.length} out-of-scope call site(s) ` +
        `acquired a \`tx\` or were deleted.\n` +
        `\`not-gated\` and \`pre-auth\` sites are CORRECT unbound — no policy applies ` +
        `to the first, and the second is an adjudicated actorless read ` +
        `(MOTIR-2784). Binding one contradicts a recorded decision, and it looks ` +
        `exactly like real work in the diff, which is why it is a build failure ` +
        `rather than a review note.\n` +
        `Run the classifier and compare against your batch's target directories.`,
    ).toBeGreaterThanOrEqual(UNTOUCHED_OUT_OF_SCOPE_FLOOR);
  });

  it('every call site in the suite is classifiable', () => {
    const { unclassifiable } = scanTestCallSites();

    expect(
      unclassifiable,
      `these test call sites name a repository method the classifier cannot find, ` +
        `usually because the method was renamed or removed:\n` +
        unclassifiable.map((u) => `  ${u.file}:${u.line} ${u.callee}`).join('\n'),
    ).toEqual([]);
  });

  it('the file-level adjudication is exactly what a human put there', () => {
    // `adjudicated-unbound` is the one verdict a parser cannot derive: the call
    // site looks exactly like in-scope work and only the FILE's subject says
    // otherwise. So the set is pinned, and a new entry fails here until somebody
    // adds it on purpose — an entry silently converts real work into "leave it".
    expect(Object.keys(ADJUDICATED_UNBOUND_FILES).sort()).toEqual([
      'tests/comments/repositories.test.ts',
      'tests/custom-fields/repositories.test.ts',
      'tests/integration/sprints/repository.test.ts',
      'tests/labels-components-watch/repositories.test.ts',
      'tests/notifications/repositories.test.ts',
    ]);
    for (const [file, reason] of Object.entries(ADJUDICATED_UNBOUND_FILES)) {
      expect(existsSync(path.join(process.cwd(), file)), `${file} does not exist`).toBe(true);
      expect(reason, `${file}'s adjudication must cite the card that decided it`).toMatch(
        /MOTIR-\d+/,
      );
    }

    const { sites } = scanTestCallSites();
    const adjudicated = sites.filter((s) => s.verdict === 'adjudicated-unbound');
    expect(adjudicated.length).toBeGreaterThan(0);
    // A write in an adjudicated file still requires its `tx` and still reads as
    // bound: the decision is "do not bind these READS", not "this file is exempt".
    expect(adjudicated.every((s) => !s.bound)).toBe(true);
  });

  it('the pre-auth adjudication is actually being read', () => {
    // `preAuthKeys` parses the MOTIR-2784 guard's VERDICTS map by NAME. A rename
    // there would make it return an empty set — silently re-opening two settled
    // sites as in-scope work. This is the tripwire for that.
    expect([...preAuthKeys()].sort()).toEqual([
      'rateLimitCounterRepository.ts#countAllUnsafe',
      'rateLimitCounterRepository.ts#findCountUnsafe',
    ]);
  });
});
