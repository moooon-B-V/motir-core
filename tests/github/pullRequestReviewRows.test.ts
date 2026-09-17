import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { countDelegateCalls } from '../helpers/countDelegateCalls';

// THE REVIEW ROWS (Story MOTIR-4910 · MOTIR-5594; `docs/decisions/approval-gates.md`
// §8 FOURTH AMENDMENT, decisions 2, 4 and 7), on a REAL Postgres.
//
// This card ships storage and NOTHING that reads it for a verdict, so these tests are
// about the row's own promises: the idempotency key, the dismissal floor, the
// concurrent write, the one-query read, the cascade, and the tenancy it inherits from
// its parent rather than declares.

const PASSWORD = 'hunter2hunter2';

async function makeWorkspace(email: string, opts: { installationId: string; repoId: string }) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: opts.installationId,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: opts.repoId,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const repo = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: workspace.id, repoId: opts.repoId },
  });
  return { user, workspace, repo, ctx: { userId: user.id, workspaceId: workspace.id } };
}

/** A pull-request row to hang reviews off. Written through the admin client: this card
 *  ships no service that creates one. */
async function makePullRequest(repoId: string, number: number) {
  return adminDb.githubPullRequest.create({
    data: {
      repoId,
      number,
      state: 'open',
      merged: false,
      headRef: `subtask/ACME-${number}`,
      baseRef: 'main',
    },
  });
}

const HEAD = 'a'.repeat(40);

function review(o: {
  githubReviewId?: string;
  githubPullRequestId: string;
  state?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  commitSha?: string;
  reviewerPermission?: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' | 'unknown';
  reviewerLogin?: string;
}) {
  return {
    githubReviewId: o.githubReviewId ?? 'gh-review-1',
    githubPullRequestId: o.githubPullRequestId,
    reviewerGithubUserId: '4242',
    reviewerLogin: o.reviewerLogin ?? 'ada-l',
    reviewerType: 'User',
    state: o.state ?? ('approved' as const),
    commitSha: o.commitSha ?? HEAD,
    reviewerPermission: o.reviewerPermission ?? ('write' as const),
    submittedAt: new Date('2026-09-16T09:12:00.000Z'),
    htmlUrl: 'https://github.com/moooon/acme/pull/131#pullrequestreview-1',
  };
}

describe('github_pull_request_review — the rows the sync writes (MOTIR-5594)', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('keys on GITHUB’s review id: upserting the same id twice leaves exactly one row', async () => {
    const fx = await makeWorkspace('rows-idem@example.com', {
      installationId: 'inst-rev-1',
      repoId: '9001',
    });
    const pr = await makePullRequest(fx.repo.id, 131);

    const first = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubPullRequestId: pr.id }),
        tx,
      ),
    );
    // A redelivery of the SAME review, carrying a later permission read.
    const second = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubPullRequestId: pr.id, reviewerPermission: 'admin' }),
        tx,
      ),
    );

    expect(second.id).toBe(first.id);
    const rows = await adminDb.githubPullRequestReview.findMany({
      where: { githubPullRequestId: pr.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reviewerPermission).toBe('admin');
    // The immutable half of the row is untouched by the redelivery.
    expect(rows[0]!.commitSha).toBe(HEAD);
    expect(rows[0]!.reviewerGithubUserId).toBe('4242');
  });

  it('is a FLOOR at dismissed — a later approved upsert for the same id does not resurrect it', async () => {
    const fx = await makeWorkspace('rows-dismissed@example.com', {
      installationId: 'inst-rev-2',
      repoId: '9002',
    });
    const pr = await makePullRequest(fx.repo.id, 132);

    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubPullRequestId: pr.id, state: 'dismissed' }),
        tx,
      ),
    );
    // GitHub delivers `submitted` and `dismissed` separately and promises no order,
    // so this is the out-of-order redelivery of the ORIGINAL approval.
    const after = await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubPullRequestId: pr.id, state: 'approved' }),
        tx,
      ),
    );

    expect(after.state).toBe('dismissed');
    const row = await adminDb.githubPullRequestReview.findUniqueOrThrow({
      where: { githubReviewId: 'gh-review-1' },
    });
    expect(row.state).toBe('dismissed');
  });

  it('survives two GENUINELY concurrent upserts of one review id — one row, neither throws', async () => {
    const fx = await makeWorkspace('rows-race@example.com', {
      installationId: 'inst-rev-3',
      repoId: '9003',
    });
    const pr = await makePullRequest(fx.repo.id, 133);

    // Both start before either commits: the unique index is what decides, not a
    // read-then-write, and the loser must OBSERVE the winner rather than fail.
    const [a, b] = await Promise.all([
      withWorkspaceContext(fx.ctx, (tx) =>
        githubPullRequestReviewRepository.upsertByGithubReviewId(
          review({ githubPullRequestId: pr.id }),
          tx,
        ),
      ),
      withWorkspaceContext(fx.ctx, (tx) =>
        githubPullRequestReviewRepository.upsertByGithubReviewId(
          review({ githubPullRequestId: pr.id }),
          tx,
        ),
      ),
    ]);

    expect(a.id).toBe(b.id);
    await expect(
      adminDb.githubPullRequestReview.count({ where: { githubReviewId: 'gh-review-1' } }),
    ).resolves.toBe(1);
  });

  it('reads every review for the requested pull requests, and no other, in ONE query', async () => {
    const fx = await makeWorkspace('rows-read@example.com', {
      installationId: 'inst-rev-4',
      repoId: '9004',
    });
    const wanted = await makePullRequest(fx.repo.id, 134);
    const alsoWanted = await makePullRequest(fx.repo.id, 135);
    const other = await makePullRequest(fx.repo.id, 136);

    await withWorkspaceContext(fx.ctx, async (tx) => {
      // Two heads on one pull request: the read must NOT filter to a head, because
      // the Development block draws a review at an EARLIER commit (design § 23, G2).
      await githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubReviewId: 'r-1', githubPullRequestId: wanted.id }),
        tx,
      );
      await githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({
          githubReviewId: 'r-2',
          githubPullRequestId: wanted.id,
          commitSha: 'b'.repeat(40),
        }),
        tx,
      );
      await githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubReviewId: 'r-3', githubPullRequestId: alsoWanted.id }),
        tx,
      );
      await githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubReviewId: 'r-4', githubPullRequestId: other.id }),
        tx,
      );
    });

    const { result, queries } = await countDelegateCalls(
      'githubPullRequestReview',
      'findMany',
      () =>
        withWorkspaceContext(fx.ctx, (tx) =>
          githubPullRequestReviewRepository.listForPullRequests([wanted.id, alsoWanted.id], tx),
        ),
    );

    expect(queries).toBe(1);
    expect(result.map((r) => r.githubReviewId).sort()).toEqual(['r-1', 'r-2', 'r-3']);
  });

  it('reads nothing, and queries nothing, for an empty id list', async () => {
    const fx = await makeWorkspace('rows-empty@example.com', {
      installationId: 'inst-rev-5',
      repoId: '9005',
    });
    const { result, queries } = await countDelegateCalls(
      'githubPullRequestReview',
      'findMany',
      () =>
        withWorkspaceContext(fx.ctx, (tx) =>
          githubPullRequestReviewRepository.listForPullRequests([], tx),
        ),
    );
    expect(result).toEqual([]);
    expect(queries).toBe(0);
  });

  it('CASCADES — deleting the pull request removes its review rows', async () => {
    const fx = await makeWorkspace('rows-cascade@example.com', {
      installationId: 'inst-rev-6',
      repoId: '9006',
    });
    const pr = await makePullRequest(fx.repo.id, 137);
    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubPullRequestId: pr.id }),
        tx,
      ),
    );

    await adminDb.githubPullRequest.delete({ where: { id: pr.id } });

    await expect(
      adminDb.githubPullRequestReview.count({ where: { githubPullRequestId: pr.id } }),
    ).resolves.toBe(0);
  });

  it('inherits its PARENT’s tenancy — a foreign workspace reads no rows', async () => {
    // The table has no workspace column of its own: like `github_pull_request_queue_exit`,
    // its policy joins `github_pull_request → github_repo`. This is the assertion that
    // the join was actually written, rather than the table shipping unguarded.
    const mine = await makeWorkspace('rows-rls-mine@example.com', {
      installationId: 'inst-rev-7',
      repoId: '9007',
    });
    const theirs = await makeWorkspace('rows-rls-theirs@example.com', {
      installationId: 'inst-rev-8',
      repoId: '9008',
    });
    const pr = await makePullRequest(mine.repo.id, 138);
    await withWorkspaceContext(mine.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        review({ githubPullRequestId: pr.id }),
        tx,
      ),
    );

    const asOwner = await withWorkspaceContext(mine.ctx, (tx) =>
      githubPullRequestReviewRepository.listForPullRequests([pr.id], tx),
    );
    expect(asOwner).toHaveLength(1);

    const asStranger = await withWorkspaceContext(theirs.ctx, (tx) =>
      githubPullRequestReviewRepository.listForPullRequests([pr.id], tx),
    );
    expect(asStranger).toEqual([]);
  });

  it('carries `github_review` on the authority enum, and Postgres accepts it', async () => {
    // The member the decide door (MOTIR-5596) will write. Asserted against the live
    // type rather than the schema file, because the migration is what ships.
    const values = await db.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'approval_gate_authority'
       ORDER BY e.enumsortorder`,
    );
    expect(values.map((v) => v.enumlabel)).toEqual([
      'assignee',
      'reporter',
      'admin',
      'github_review',
    ]);
  });
});
