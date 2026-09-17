import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import * as mergeService from '@/lib/services/pullRequestMergeService';
import { evaluateForWorkItem } from '@/lib/services/pullRequestReviewSync';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A SYNCED APPROVAL MERGES THE SET (Story MOTIR-4910 · MOTIR-5608;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decision 6), on a REAL Postgres.
//
// ⚠️ THE PROPERTY UNDER TEST IS THAT IT IS THE SAME PATH. A synced approval must merge
// through `mergeApprovedSetMembers` — the press's own step 2 — so a second merge
// implementation fails the first test here. The host is the provider seam, stubbed per pull
// request: the one thing that leaves the process.

const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Member {
  pullRequestId: string;
  version: string;
  headSha: string;
  number: number;
}

/** A card in review, two green pull requests, holding its ONE awaiting approve-to-merge gate. */
async function approvable() {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);

  const members: Record<'web' | 'api', Member> = {} as never;
  for (const [name, number, head] of [
    ['web', 7, HEAD_WEB],
    ['api', 12, HEAD_API],
  ] as const) {
    seq += 1;
    const installation = await adminDb.githubInstallation.create({
      data: {
        workspaceId: fx.workspaceId,
        installationId: `inst-5608-${seq}`,
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
        repoId: `repo-5608-${seq}`,
        owner: 'acme',
        name,
        defaultBranch: 'main',
        provider: 'github',
      },
    });
    const pr = await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number,
        title: `Change in ${name}`,
        state: 'open',
        headRef: 'parent/ACME-12-throttle',
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
      data: { pullRequestId: pr.id, commitSha: head, checkName: 'Vitest', conclusion: 'success' },
    });
    members[name] = {
      pullRequestId: pr.id,
      version: `acme/${name}#${number}@${head}`,
      headSha: head,
      number,
    };
  }

  const subjectVersion = [members.web.version, members.api.version].sort().join(',');
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_approval',
        subjectId: item.id,
        subjectVersion,
      },
      tx,
    ),
  );
  return { item, gate, members };
}

let reviewSeq = 0;
async function approve(member: Member, login = 'ada-l', githubUserId = '4242') {
  reviewSeq += 1;
  return withWorkspaceContext(fx.ctx, (tx) =>
    githubPullRequestReviewRepository.upsertByGithubReviewId(
      {
        githubReviewId: `gh-5608-${reviewSeq}`,
        githubPullRequestId: member.pullRequestId,
        reviewerGithubUserId: githubUserId,
        reviewerLogin: login,
        reviewerType: 'User',
        state: 'approved',
        commitSha: member.headSha,
        reviewerPermission: 'write',
        submittedAt: new Date(`2026-09-16T09:${String(reviewSeq % 60).padStart(2, '0')}:00Z`),
        htmlUrl: null,
      },
      tx,
    ),
  );
}

/** Answer the host per pull-request number. */
function stubHost(answers: Record<number, MergeChangeRequestResult>) {
  return vi
    .spyOn(github, 'mergeChangeRequest')
    .mockImplementation(async (args) => answers[args.number]!);
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const prRecord = async (id: string) => {
  const row = await adminDb.githubPullRequest.findUniqueOrThrow({ where: { id } });
  return { mergeAuthority: row.mergeAuthority, mergeOutcomeRef: row.mergeOutcomeRef };
};
const statusOf = (id: string) =>
  adminDb.workItem.findUniqueOrThrow({ where: { id } }).then((i) => i.status);

describe('a synced approval MERGES, through the press’s own path (MOTIR-5608)', () => {
  it('merges both members and records each outcome on its pull request', async () => {
    const { item, gate, members } = await approvable();
    // ⚠️ The spy is on the SHARED function: a second merge implementation fails this.
    const shared = vi.spyOn(mergeService, 'mergeApprovedSetMembers');
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });

    await approve(members.web);
    await approve(members.api, 'second-reviewer', '9999');
    await evaluateForWorkItem(item.id, fx.workspaceId);

    expect(shared).toHaveBeenCalledTimes(1);
    expect((await gateRow(gate.id)).state).toBe('approved');
    // The outcome a PRESS records — same authority, same ref shape.
    expect(await prRecord(members.web.pullRequestId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-web',
    });
    expect(await prRecord(members.api.pullRequestId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'merge-api',
    });
  });

  it('records an ENQUEUE as the press does', async () => {
    const { item, members } = await approvable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'enqueued', entryId: 'MQE_1' },
    });

    await approve(members.web);
    await approve(members.api, 'second-reviewer', '9999');
    await evaluateForWorkItem(item.id, fx.workspaceId);

    expect(await prRecord(members.api.pullRequestId)).toEqual({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'queue:MQE_1',
    });
  });

  it('leaves the approval STANDING when the host refuses one member, and still merges the other', async () => {
    const { item, gate, members } = await approvable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'refused', refusal: { code: 'conflict' } },
    });

    await approve(members.web);
    await approve(members.api, 'second-reviewer', '9999');
    await evaluateForWorkItem(item.id, fx.workspaceId);

    // Neither the decision nor the card's status is rolled back by a host refusal.
    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    // The other member still merged.
    expect((await prRecord(members.web.pullRequestId)).mergeOutcomeRef).toBe('merge-web');
    expect((await prRecord(members.api.pullRequestId)).mergeOutcomeRef).toBeNull();
  });

  it('SURVIVES a throw in the merge step — the decision and the status write stand', async () => {
    const { item, gate, members } = await approvable();
    const boom = vi
      .spyOn(mergeService, 'mergeApprovedSetMembers')
      .mockRejectedValue(new Error('the merge step exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await approve(members.web);
    await approve(members.api, 'second-reviewer', '9999');
    // It must not reject: the decision has already committed by the time the merge runs.
    await expect(evaluateForWorkItem(item.id, fx.workspaceId)).resolves.toMatchObject({
      outcome: 'decided_approved',
    });

    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await statusOf(item.id)).toBe('approved');
    // Logged against the gate, so the failure is findable.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('syncedMergeRunner'),
      expect.objectContaining({ gateId: gate.id }),
    );
    boom.mockRestore();
  });
});

describe('what does NOT merge (MOTIR-5608)', () => {
  it('a synced CHANGES REQUESTED merges nothing', async () => {
    const { item, members } = await approvable();
    const shared = vi.spyOn(mergeService, 'mergeApprovedSetMembers');
    const host = stubHost({});

    await approve(members.web);
    reviewSeq += 1;
    await withWorkspaceContext(fx.ctx, (tx) =>
      githubPullRequestReviewRepository.upsertByGithubReviewId(
        {
          githubReviewId: `gh-5608-cr-${reviewSeq}`,
          githubPullRequestId: members.api.pullRequestId,
          reviewerGithubUserId: '777',
          reviewerLogin: 'objector',
          reviewerType: 'User',
          state: 'changes_requested',
          commitSha: members.api.headSha,
          reviewerPermission: 'write',
          submittedAt: new Date('2026-09-16T10:00:00Z'),
          htmlUrl: null,
        },
        tx,
      ),
    );

    await evaluateForWorkItem(item.id, fx.workspaceId);
    expect(shared).not.toHaveBeenCalled();
    expect(host).not.toHaveBeenCalled();
  });

  it('a SECOND evaluation of a decided gate merges nothing again', async () => {
    const { item, members } = await approvable();
    stubHost({
      7: { outcome: 'merged', commitSha: 'merge-web' },
      12: { outcome: 'merged', commitSha: 'merge-api' },
    });
    await approve(members.web);
    await approve(members.api, 'second-reviewer', '9999');
    await evaluateForWorkItem(item.id, fx.workspaceId);

    const shared = vi.spyOn(mergeService, 'mergeApprovedSetMembers');
    // The door raises `ApprovalGateAlreadyDecidedError` — or the gate is simply no longer
    // awaiting — before the merge step is ever reached.
    await evaluateForWorkItem(item.id, fx.workspaceId);
    expect(shared).not.toHaveBeenCalled();
  });
});
