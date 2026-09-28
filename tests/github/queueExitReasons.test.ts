import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyQueueExit,
  classOfQueueExit,
  judgeQueueExit,
  QUEUE_EXIT_REASONS,
  type LandingClass,
} from '@/lib/mergeQueue/queueExit';
import { getGitProvider } from '@/lib/git';

/** An exit as it was stored under the reason's OWN disposition — a `CI_FAILURE` /
 *  `CI_TIMEOUT` whose check did not hang, or one in an `auto` project. The SIXTH
 *  AMENDMENT's re-judged rows are asserted by the judge's table below. */
const asStored = (reason: string | null | undefined) => ({
  rawReason: reason,
  disposition: classifyQueueExit(reason).disposition,
});

// THE REASON MAP (Story MOTIR-5461 · MOTIR-5632; `docs/decisions/approval-gates.md` §4
// THIRD AMENDMENT, decision 2) and GitHub's parser for the `dequeued` delivery. The
// table below is the decision record's, row for row, stated here rather than read back
// from the module under test.

const RECORD: ReadonlyArray<[string, 'failure' | 'neutral' | 'landed']> = [
  ['CI_FAILURE', 'failure'],
  ['CI_TIMEOUT', 'failure'],
  ['MERGE_CONFLICT', 'failure'],
  ['INVALID_MERGE_COMMIT', 'failure'],
  ['GIT_TREE_INVALID', 'failure'],
  ['BRANCH_PROTECTIONS', 'failure'],
  ['MANUAL', 'neutral'],
  ['QUEUE_CLEARED', 'neutral'],
  ['ROLL_BACK', 'neutral'],
  ['UNKNOWN_REMOVAL_REASON', 'neutral'],
  ['MERGE', 'landed'],
  ['ALREADY_MERGED', 'landed'],
];

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`), 'utf8'),
  ).payload as Record<string, unknown>;

describe('classifyQueueExit', () => {
  it.each(RECORD)('%s → %s', (reason, disposition) => {
    expect(classifyQueueExit(reason)).toEqual({ disposition, recognised: true });
  });

  it('is TOTAL over the record: the module maps exactly the record’s values', () => {
    expect(Object.entries(QUEUE_EXIT_REASONS).sort()).toEqual([...RECORD].sort());
  });

  it.each([
    // The GraphQL timeline's spellings never reach a webhook, and are not case-folded.
    'failed_checks',
    'merged',
    'ci_failure',
    'SOMETHING_GITHUB_ADDS_LATER',
    '',
  ])('an unrecognised %j is neutral and reported as unrecognised', (reason) => {
    expect(classifyQueueExit(reason)).toEqual({ disposition: 'neutral', recognised: false });
  });

  it('no reason at all is neutral and unrecognised', () => {
    expect(classifyQueueExit(null)).toEqual({ disposition: 'neutral', recognised: false });
    expect(classifyQueueExit(undefined)).toEqual({ disposition: 'neutral', recognised: false });
  });

  it('an inherited property name is not a reason', () => {
    expect(classifyQueueExit('toString')).toEqual({ disposition: 'neutral', recognised: false });
  });
});

describe('GitHub’s parseMergeQueueExitEvent, over the captured deliveries', () => {
  const github = getGitProvider('github');

  it.each([
    ['dequeued-ci-failure', 2830, '3b59a33bcb2a1012a0008073d96db51ec8b9438a', 'CI_FAILURE'],
    ['dequeued-manual', 2864, 'ceff8b254e27b44e98d7e88811a5d746b2a81690', 'MANUAL'],
    ['dequeued-merge', 2843, '34efea188bc827b456d3fb0ee2daabc5db4d429e', 'MERGE'],
  ])('%s normalises', (name, number, headSha, rawReason) => {
    expect(github.parseMergeQueueExitEvent!(fixture(name))).toEqual({
      providerRepoId: '1246103300',
      number,
      headSha,
      rawReason,
    });
  });

  it('a missing reason is carried as null, not a refusal', () => {
    const body = fixture('dequeued-ci-failure');
    delete body['reason'];
    expect(github.parseMergeQueueExitEvent!(body)).toMatchObject({ rawReason: null });
  });

  it.each([
    ['another action', (b: Record<string, unknown>) => ({ ...b, action: 'enqueued' })],
    ['no repository id', (b: Record<string, unknown>) => ({ ...b, repository: {} })],
    ['no number', (b: Record<string, unknown>) => ({ ...b, pull_request: { head: { sha: 'x' } } })],
    [
      'no head sha',
      (b: Record<string, unknown>) => ({ ...b, pull_request: { number: 1, head: {} } }),
    ],
    ['a non-object body', () => 'dequeued' as unknown as Record<string, unknown>],
  ])('%s → null', (_label, mutate) => {
    expect(github.parseMergeQueueExitEvent!(mutate(fixture('dequeued-ci-failure')))).toBeNull();
  });

  it('GitLab does not declare the capability', () => {
    expect(getGitProvider('gitlab').parseMergeQueueExitEvent).toBeUndefined();
  });
});

// THE CLASS MAP (§4 FOURTH AMENDMENT, point 2; MOTIR-5802) — what a person can DO about
// an un-landed merge, which is a different question from what the removal did to the card.
// Stated here row for row, from the record rather than from the module under test. The
// four queue FAILURES are CAN'T-LAND since the FIFTH AMENDMENT (MOTIR-6594).
const CLASSES: ReadonlyArray<[string, LandingClass]> = [
  ['CI_FAILURE', 'cant_land'],
  ['CI_TIMEOUT', 'cant_land'],
  ['INVALID_MERGE_COMMIT', 'cant_land'],
  ['GIT_TREE_INVALID', 'cant_land'],
  ['MANUAL', 'retryable'],
  ['QUEUE_CLEARED', 'retryable'],
  ['ROLL_BACK', 'retryable'],
  ['UNKNOWN_REMOVAL_REASON', 'retryable'],
  ['MERGE_CONFLICT', 'cant_land'],
  ['BRANCH_PROTECTIONS', 'setting'],
  ['MERGE', 'landed'],
  ['ALREADY_MERGED', 'landed'],
];

describe('what can be DONE about an un-landed merge — the class map', () => {
  it.each(CLASSES)('%s → %s', (reason, expected) => {
    expect(classOfQueueExit(asStored(reason))).toBe(expected);
  });

  it('is TOTAL over the reason map — every reason it names has a class', () => {
    expect(CLASSES.map(([reason]) => reason).sort()).toEqual(
      Object.keys(QUEUE_EXIT_REASONS).sort(),
    );
  });

  it('an unmapped reason is RETRYABLE, so a person is asked rather than offered nothing', () => {
    expect(classOfQueueExit(asStored('SOME_NEW_REASON'))).toBe('retryable');
    expect(classOfQueueExit(asStored(null))).toBe('retryable');
    expect(classOfQueueExit(asStored(undefined))).toBe('retryable');
  });

  // THE FIFTH AMENDMENT's line (MOTIR-6594): every FAILURE is can't-land EXCEPT the one a
  // setting answers, and nothing that is not a failure is can't-land. Asserted over the
  // whole reason map, so a reason added later cannot slip into either side unclassed.
  it('a failure is CAN’T-LAND unless a setting answers it; nothing else is', () => {
    for (const [reason, disposition] of Object.entries(QUEUE_EXIT_REASONS)) {
      const cls = classOfQueueExit(asStored(reason));
      if (disposition === 'failure' && reason !== 'BRANCH_PROTECTIONS') {
        expect(cls, reason).toBe('cant_land');
      } else {
        expect(cls, reason).not.toBe('cant_land');
      }
    }
  });

  it('the class is not the disposition — BRANCH_PROTECTIONS and MANUAL are the tells', () => {
    expect(classifyQueueExit('BRANCH_PROTECTIONS').disposition).toBe('failure');
    expect(classOfQueueExit(asStored('BRANCH_PROTECTIONS'))).toBe('setting');
    expect(classifyQueueExit('MANUAL').disposition).toBe('neutral');
    expect(classOfQueueExit(asStored('MANUAL'))).toBe('retryable');
  });
});

// §4 SIXTH AMENDMENT's table (MOTIR-6844 · MOTIR-6847): the judge over EVERY reason ×
// every conclusion a merge-group check can end with, plus none recorded. Stated here
// rather than read back from the module, as the reason table above is.
describe('the judge — a queue exit by its REASON and its check’s CONCLUSION', () => {
  const CONCLUSIONS = [
    'cancelled',
    'timed_out',
    'failure',
    'startup_failure',
    'action_required',
    null,
  ];
  const HUNG = new Set(['cancelled', 'timed_out']);

  function expected(reason: string, conclusion: string | null) {
    if (reason === 'CI_FAILURE') {
      return conclusion !== null && HUNG.has(conclusion)
        ? { disposition: 'neutral', landingClass: 'retryable' }
        : { disposition: 'failure', landingClass: 'cant_land' };
    }
    if (reason === 'CI_TIMEOUT') {
      return conclusion === null || HUNG.has(conclusion)
        ? { disposition: 'neutral', landingClass: 'retryable' }
        : { disposition: 'failure', landingClass: 'cant_land' };
    }
    // Every other reason answers exactly what the two tables above answer.
    return {
      disposition: classifyQueueExit(reason).disposition,
      landingClass: classOfQueueExit(asStored(reason)),
    };
  }

  const rows = [...Object.keys(QUEUE_EXIT_REASONS), 'SOMETHING_NEW'].flatMap((reason) =>
    CONCLUSIONS.map((conclusion) => [reason, conclusion] as const),
  );

  it.each(rows)('%s with %s', (reason, conclusion) => {
    expect(judgeQueueExit({ rawReason: reason, failingCheckConclusion: conclusion })).toEqual(
      expected(reason, conclusion),
    );
  });

  it('the stored disposition decides the class of a CI_FAILURE / CI_TIMEOUT — so auto’s kept `failure` stays can’t-land', () => {
    for (const reason of ['CI_FAILURE', 'CI_TIMEOUT']) {
      expect(classOfQueueExit({ rawReason: reason, disposition: 'neutral' })).toBe('retryable');
      expect(classOfQueueExit({ rawReason: reason, disposition: 'failure' })).toBe('cant_land');
    }
  });

  it('the class a judged exit is stored with agrees with the judge', () => {
    for (const [reason, conclusion] of rows) {
      const judged = judgeQueueExit({ rawReason: reason, failingCheckConclusion: conclusion });
      if (judged.disposition === 'landed') continue;
      expect(classOfQueueExit({ rawReason: reason, disposition: judged.disposition })).toBe(
        judged.landingClass,
      );
    }
  });
});
