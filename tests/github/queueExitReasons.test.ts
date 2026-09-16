import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyQueueExit, QUEUE_EXIT_REASONS } from '@/lib/mergeQueue/queueExit';
import { getGitProvider } from '@/lib/git';

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
