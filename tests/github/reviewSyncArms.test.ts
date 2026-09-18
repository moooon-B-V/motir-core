import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';

import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { runSyncedMerge } from '@/lib/services/syncedMergeRunner';
import * as mergeService from '@/lib/services/pullRequestMergeService';

// THE ARMS BETWEEN THE CHILDREN (Story MOTIR-4910 · MOTIR-5600 §1).
//
// Every child shipped its own units; what the coverage floor still wanted was the handful of
// arms that only run when something goes wrong at exactly the wrong moment. Each one below is
// RULE-BEARING rather than defensive — it decides what a caller sees — so each gets a case
// rather than an ignore directive.
//
// ⚠️ THE REPOSITORY IS DRIVEN THROUGH ITS OWN `tx` PARAMETER. Its concurrency arm fires only
// when a genuinely simultaneous insert loses the unique race, which a test cannot schedule on
// demand — running many at once and hoping is the definition of a flaky test. But the method
// TAKES its transaction client, so the race can be handed to it exactly rather than waited
// for. Nothing here touches a database.
//
// ⚠️ THE RACE IS NOW SIGNALLED BY AN EMPTY INSERT, NOT BY A THROWN P2002 (MOTIR-5693). The
// write is `createManyAndReturn` + `skipDuplicates` — `INSERT … ON CONFLICT DO NOTHING` —
// because a raised P2002 ABORTS the enclosing Postgres transaction and the recovery read
// could never run inside it. So the loser is handed `[]` here, exactly as Postgres hands it
// `0 rows`, and the arm that used to be reached by rejecting is reached by returning nothing.

afterEach(() => {
  vi.restoreAllMocks();
});

const INPUT = {
  githubReviewId: 'gh-race-1',
  githubPullRequestId: 'pr-1',
  reviewerGithubUserId: '4242',
  reviewerLogin: 'ada-l',
  reviewerType: 'User',
  state: 'approved' as const,
  commitSha: 'a'.repeat(40),
  reviewerPermission: 'write' as const,
  submittedAt: new Date('2026-09-16T09:12:00.000Z'),
  htmlUrl: null,
};

const WINNER = { id: 'row-1', githubReviewId: 'gh-race-1', state: 'approved' };

/** A transaction client that answers exactly the three calls the upsert makes.
 *
 *  `insertReturns` is what `ON CONFLICT DO NOTHING` gives back: `[row]` when this
 *  caller created it, `[]` when the unique already held — which IS the lost race. */
function stubTx(opts: {
  updatedCount: number;
  insertReturns?: unknown[];
  insertThrows?: unknown;
  findUniqueReturns?: unknown;
}): Prisma.TransactionClient {
  return {
    githubPullRequestReview: {
      updateMany: vi.fn().mockResolvedValue({ count: opts.updatedCount }),
      createManyAndReturn: vi.fn().mockImplementation(() => {
        if (opts.insertThrows) return Promise.reject(opts.insertThrows);
        return Promise.resolve(opts.insertReturns ?? [WINNER]);
      }),
      findUnique: vi.fn().mockResolvedValue(opts.findUniqueReturns ?? null),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('the upsert LOSES the unique race (MOTIR-5600 §1)', () => {
  it('observes the winner’s row instead of throwing', async () => {
    // The row did not exist when this caller looked, and did by the time it inserted — so
    // Postgres skipped the insert and handed back no rows.
    const tx = stubTx({ updatedCount: 0, insertReturns: [], findUniqueReturns: WINNER });

    // ⚠️ NEITHER CALLER THROWS AND EXACTLY ONE ROW EXISTS — that is the promise the webhook
    // arm rests on, because two copies of one delivery arriving at once is ordinary.
    await expect(
      githubPullRequestReviewRepository.upsertByGithubReviewId(INPUT, tx),
    ).resolves.toMatchObject({ githubReviewId: 'gh-race-1' });
  });

  it('RETHROWS a failure that is not the race — a real error is not swallowed as one', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: 'P1001' });
    const tx = stubTx({ updatedCount: 0, insertThrows: boom });

    // ⚠️ THERE IS NO `catch` LEFT TO GET THIS WRONG, and that is the improvement rather than
    // an accident of this test: the duplicate is absorbed by Postgres at the INSERT, so a
    // real failure has nothing between it and the caller.
    await expect(githubPullRequestReviewRepository.upsertByGithubReviewId(INPUT, tx)).rejects.toBe(
      boom,
    );
  });

  it('throws when the insert was skipped but no winner can be read back', async () => {
    // Nothing inserted and nothing to find means the conflict was not the one this arm
    // models, so answering with a row would be an invention. The message names the review.
    const tx = stubTx({ updatedCount: 0, insertReturns: [], findUniqueReturns: null });

    await expect(
      githubPullRequestReviewRepository.upsertByGithubReviewId(INPUT, tx),
    ).rejects.toThrow(/gh-race-1 was neither inserted nor found/);
  });

  it('throws a NAMED error when an updated row vanishes underneath the read', async () => {
    // `updateMany` matched, so the row existed a moment ago; a null read back means it was
    // deleted mid-transaction. It is not a race this arm can answer, and the message says
    // which review so the row is findable.
    const tx = stubTx({ updatedCount: 1, findUniqueReturns: null });

    await expect(
      githubPullRequestReviewRepository.upsertByGithubReviewId(INPUT, tx),
    ).rejects.toThrow(/gh-race-1 vanished/);
  });
});

describe('the merge after a synced approval NEVER throws (MOTIR-5600 §1)', () => {
  it('swallows and LOGS a failure — the decision has already committed', async () => {
    const boom = new Error('the host fell over');
    const shared = vi.spyOn(mergeService, 'mergeApprovedSetMembers').mockRejectedValue(boom);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // ⚠️ A THROW HERE COULD ONLY TURN A PARTIAL MERGE INTO AN UNHANDLED REJECTION IN A
    // WEBHOOK HANDLER. By this point a reviewer's decision is committed and the card reads
    // Approved; nothing this function does can unwind that.
    await expect(
      runSyncedMerge({
        gateId: 'gate-1',
        workItemId: 'item-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        members: [{ subjectVersion: 'o/n#1@abc', repo: 'o/n', number: 1, headSha: 'abc' }],
      }),
    ).resolves.toBeUndefined();

    expect(shared).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('syncedMergeRunner'),
      expect.objectContaining({ gateId: 'gate-1' }),
    );
  });

  it('LOGS a host refusal without treating it as a failure', async () => {
    vi.spyOn(mergeService, 'mergeApprovedSetMembers').mockResolvedValue([
      {
        subjectVersion: 'o/n#1@abc',
        pullRequestId: 'pr-1',
        outcome: 'refused',
        refusal: { tag: 'MERGE_CONFLICT' },
      },
      { subjectVersion: 'o/n#2@def', pullRequestId: 'pr-2', outcome: 'merged' },
    ] as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runSyncedMerge({
      gateId: 'gate-2',
      workItemId: 'item-2',
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      members: [],
    });

    // The approval stands and the refused member is retried from the frame — so this is
    // visibility, not an error path.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('refused by the host'),
      expect.objectContaining({ refused: ['o/n#1@abc'] }),
    );
  });
});
