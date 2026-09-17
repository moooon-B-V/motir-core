import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { countDelegateCalls } from '../helpers/countDelegateCalls';

// THE DEVELOPMENT BLOCK'S REVIEW READ (Story MOTIR-4910 · MOTIR-5602;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decision 2; design
// `design/github/design-notes.md` § 23, Panels G1–G3), on a REAL Postgres.
//
// A READ ONLY. What the rows then look like is MOTIR-5599's; what is asserted here is the
// DATA: which review a row carries, whether it counts, who it names, and that the whole page
// costs two queries rather than two per row.

const HEAD = 'a'.repeat(40);
const OLDER = 'c'.repeat(40);
const PASSWORD = 'hunter2hunter2';

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A card with `count` linked pull requests, each green at `HEAD`. */
async function card(count = 1) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  const prs: string[] = [];
  for (let i = 0; i < count; i += 1) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-5602-${seq}`,
        accountLogin: 'acme',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        installationId: installation.id,
        repoId: `repo-5602-${seq}`,
        owner: 'acme',
        name: `svc-${seq}`,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 100 + seq,
        title: `Change ${seq}`,
        state: 'open',
        headRef: `subtask/ACME-${seq}`,
        baseRef: 'main',
        provider: 'github',
      },
    });
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: fx.workspaceId,
        workItemId: item.id,
        githubPullRequestId: pr.id,
        repoId: repo.id,
      },
    });
    await adminDb.githubCheckRun.create({
      data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
    });
    prs.push(pr.id);
  }
  return { item, prs };
}

let reviewSeq = 0;
async function review(
  pullRequestId: string,
  o: {
    state?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
    permission?: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none' | 'unknown';
    githubUserId?: string;
    login?: string;
    commitSha?: string;
    at?: string;
  } = {},
) {
  reviewSeq += 1;
  return withWorkspaceContext(fx.ctx, (tx) =>
    githubPullRequestReviewRepository.upsertByGithubReviewId(
      {
        githubReviewId: `gh-5602-${reviewSeq}`,
        githubPullRequestId: pullRequestId,
        reviewerGithubUserId: o.githubUserId ?? '4242',
        reviewerLogin: o.login ?? 'ada-l',
        reviewerType: 'User',
        state: o.state ?? 'approved',
        commitSha: o.commitSha ?? HEAD,
        reviewerPermission: o.permission ?? 'write',
        submittedAt: new Date(
          o.at ?? `2026-09-16T09:${String(reviewSeq % 60).padStart(2, '0')}:00Z`,
        ),
        htmlUrl: null,
      },
      tx,
    ),
  );
}

const rowsFor = (workItemId: string) => workItemsService.listLinkedPullRequests(workItemId, fx.ctx);

describe('a row carries its GitHub review (MOTIR-5602)', () => {
  it('names an approving review at the CURRENT head', async () => {
    const { item, prs } = await card();
    await review(prs[0]!);

    const [row] = await rowsFor(item.id);
    expect(row!.githubReview).toEqual({
      state: 'approved',
      reviewerLogin: 'ada-l',
      memberName: null,
      atCurrentHead: true,
    });
  });

  it('marks an approval at an EARLIER commit as stale rather than dropping it', async () => {
    const { item, prs } = await card();
    await review(prs[0]!, { commitSha: OLDER });

    const [row] = await rowsFor(item.id);
    // A reader who could see an approval exists but not that it is stale would think Motir
    // had lost it (design § 23, Panel G2).
    expect(row!.githubReview).toMatchObject({ state: 'approved', atCurrentHead: false });
  });

  it('lets a later CHANGES REQUESTED from another reviewer outrank an approval', async () => {
    const { item, prs } = await card();
    await review(prs[0]!, { at: '2026-09-16T09:00:00Z' });
    await review(prs[0]!, {
      state: 'changes_requested',
      githubUserId: '777',
      login: 'objector',
      at: '2026-09-16T10:00:00Z',
    });

    const [row] = await rowsFor(item.id);
    expect(row!.githubReview).toMatchObject({
      state: 'changes_requested',
      reviewerLogin: 'objector',
      atCurrentHead: true,
    });
  });

  it('is NULL when nothing countable was said', async () => {
    const { item, prs } = await card();
    await review(prs[0]!, { state: 'commented' });
    await review(prs[0]!, { state: 'dismissed', githubUserId: '1' });
    await review(prs[0]!, { permission: 'read', githubUserId: '2' });
    await review(prs[0]!, { permission: 'unknown', githubUserId: '3' });

    const [row] = await rowsFor(item.id);
    // Absence of a countable review is not a state, exactly as `ci: null` draws no pill.
    expect(row!.githubReview).toBeNull();
  });

  it('is NULL for a pull request with no reviews at all', async () => {
    const { item } = await card();
    const [row] = await rowsFor(item.id);
    expect(row!.githubReview).toBeNull();
  });
});

describe('WHO the review names (MOTIR-5602)', () => {
  it('carries the member name when the reviewer is a member of THIS workspace', async () => {
    const { item, prs } = await card();
    const user = await usersService.createUser({
      email: 'ada@example.com',
      password: PASSWORD,
      name: 'Ada Lovelace',
    });
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await adminDb.githubIdentity.create({
      data: {
        userId: user.id,
        githubUserId: '4242',
        githubLogin: 'ada-l',
        accessTokenEncrypted: 'enc',
      },
    });
    await review(prs[0]!);

    const [row] = await rowsFor(item.id);
    expect(row!.githubReview).toMatchObject({ memberName: 'Ada Lovelace', reviewerLogin: 'ada-l' });
  });

  it('carries a NULL name for an identity that belongs to another workspace', async () => {
    const { item, prs } = await card();
    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: PASSWORD,
      name: 'Stranger',
    });
    // An identity is global; membership is what makes them a member HERE.
    await workspacesService.createWorkspace({ name: 'Elsewhere', ownerUserId: stranger.id });
    await adminDb.githubIdentity.create({
      data: {
        userId: stranger.id,
        githubUserId: '4242',
        githubLogin: 'ada-l',
        accessTokenEncrypted: 'enc',
      },
    });
    await review(prs[0]!);

    const [row] = await rowsFor(item.id);
    expect(row!.githubReview).toMatchObject({ memberName: null, reviewerLogin: 'ada-l' });
  });
});

describe('the read is BATCHED (MOTIR-5602)', () => {
  it('costs ONE review query and ONE identity query for three rows and two reviewers', async () => {
    const { item, prs } = await card(3);
    await review(prs[0]!, { githubUserId: '4242', login: 'ada-l' });
    await review(prs[1]!, { githubUserId: '9999', login: 'grace-h' });
    await review(prs[2]!, { githubUserId: '4242', login: 'ada-l' });

    const reviews = await countDelegateCalls('githubPullRequestReview', 'findMany', () =>
      rowsFor(item.id),
    );
    expect(reviews.queries).toBe(1);
    expect(reviews.result).toHaveLength(3);

    const identities = await countDelegateCalls('githubIdentity', 'findMany', () =>
      rowsFor(item.id),
    );
    expect(identities.queries).toBe(1);
  });

  it('asks NOTHING about identities when no review was recorded', async () => {
    const { item } = await card(2);
    const identities = await countDelegateCalls('githubIdentity', 'findMany', () =>
      rowsFor(item.id),
    );
    // The short-circuit is real: no reviews, no reviewers to resolve.
    expect(identities.queries).toBe(0);
  });
});
