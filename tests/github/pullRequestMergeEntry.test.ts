import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type { MergeChangeRequestResult } from '@/lib/git/types';
import {
  ApprovalGateError,
  ApprovalGateMergeRefusedError,
  ApprovalGateNotAuthorisedError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE MERGE ENTRY POINT (Story MOTIR-4882 · MOTIR-5517), against a REAL Postgres. The
// host is the seam's `mergeChangeRequest`, stubbed per case — the one thing that leaves
// the process. The property under test is the ORDER: check, merge, then decide; and a
// refusal decides nothing.

const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const github = getGitProvider('github') as Required<GitProvider>;

let fx: WorkItemFixture;

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

async function seatedOn(role: 'member' | 'viewer') {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** A card in review, delivered by pull request #7 green at HEAD, holding an awaiting
 *  merge gate raised on that head — the state `raiseMergeGates` leaves. */
async function mergeGateFor(assigneeId: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Merge me' },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId } });

  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5517-${item.id}`,
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
      repoId: `repo-5517-${item.id}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 7,
      title: 'Merge me',
      state: 'open',
      headRef: 'subtask/merge-me',
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
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: item.id,
        kind: 'pull_request_merge',
        subjectId: pr.id,
        subjectVersion: `acme/web#7@${HEAD}`,
        routedToId: assigneeId,
      },
      tx,
    ),
  );
  return { item, pr, gate, installation };
}

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const prRow = (id: string) => adminDb.githubPullRequest.findUniqueOrThrow({ where: { id } });

function stubSeam(...answers: Array<MergeChangeRequestResult | Error>) {
  const spy = vi.spyOn(github, 'mergeChangeRequest');
  for (const answer of answers) {
    if (answer instanceof Error) spy.mockRejectedValueOnce(answer);
    else spy.mockResolvedValueOnce(answer);
  }
  return spy;
}

describe('APPROVE merges first, then decides — and records the outcome on the pull request', () => {
  it('merged: ONE seam call with the gate’s head, no transaction open; approved, gate outcome null, PR record written, card unmoved', async () => {
    const assignee = await seatedOn('member');
    const { item, pr, gate, installation } = await mergeGateFor(assignee.user.id);

    // Count the transactions open at the moment the host is called.
    let open = 0;
    let opened = 0;
    let openAtSeam = -1;
    const realTransaction = db.$transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(db, '$transaction').mockImplementation(((...args: unknown[]) => {
      open += 1;
      opened += 1;
      return realTransaction(...args).finally(() => {
        open -= 1;
      });
    }) as typeof db.$transaction);
    const seam = vi.spyOn(github, 'mergeChangeRequest').mockImplementation(async () => {
      openAtSeam = open;
      return { outcome: 'merged', commitSha: 'f00dfeedcafe' };
    });

    const result = await pullRequestMergeService.decideGate(
      { gateId: gate.id, decision: 'approve', source: 'ui' },
      assignee.ctx,
    );

    expect(seam).toHaveBeenCalledTimes(1);
    expect(seam).toHaveBeenCalledWith({
      installationId: installation.installationId,
      owner: 'acme',
      name: 'web',
      number: 7,
      expectedHeadSha: HEAD,
    });
    // The spy really sits on the transaction entry — the check, the decision and the
    // record each opened one — so the zero below is a measurement, not a default.
    expect(opened).toBeGreaterThanOrEqual(3);
    expect(openAtSeam).toBe(0);

    expect(result.gate.state).toBe('approved');
    expect(result.gate.outcomeRef).toBeNull();
    expect((await prRow(pr.id)).mergeAuthority).toBe('gate');
    expect((await prRow(pr.id)).mergeOutcomeRef).toBe('f00dfeedcafe');
    const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(card.status).toBe('in_review');
  });

  it('enqueued: the pull request records queue:<entryId>, and the gate outcome stays null', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await mergeGateFor(assignee.user.id);
    stubSeam({ outcome: 'enqueued', entryId: 'MQE_1' });

    const result = await pullRequestMergeService.approveMergeGate(
      { gateId: gate.id, source: 'api' },
      assignee.ctx,
    );

    expect(result.gate.state).toBe('approved');
    expect(result.gate.outcomeRef).toBeNull();
    expect((await prRow(pr.id)).mergeOutcomeRef).toBe('queue:MQE_1');
  });
});

describe('a host REFUSAL decides nothing and writes nothing', () => {
  const MATRIX = [
    { code: 'checks_not_green', tag: 'MERGE_CHECKS_NOT_GREEN' },
    { code: 'conflict', tag: 'MERGE_CONFLICT' },
    { code: 'branch_protected', tag: 'MERGE_BRANCH_PROTECTED', reason: 'A review is required.' },
    { code: 'already_merged', tag: 'MERGE_ALREADY_MERGED' },
    {
      code: 'app_permission_missing',
      tag: 'MERGE_APP_PERMISSION_MISSING',
      permission: 'contents: write',
    },
  ] as const;

  it.each(MATRIX)('$code → $tag; the gate stays awaiting', async (row) => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await mergeGateFor(assignee.user.id);
    stubSeam({
      outcome: 'refused',
      refusal: {
        code: row.code,
        ...('reason' in row ? { reason: row.reason } : {}),
        ...('permission' in row ? { permission: row.permission } : {}),
      },
    });

    const refused = await pullRequestMergeService
      .decideGate({ gateId: gate.id, decision: 'approve', source: 'ui' }, assignee.ctx)
      .catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(ApprovalGateMergeRefusedError);
    const err = refused as ApprovalGateMergeRefusedError;
    expect(err.tag).toBe(row.tag);
    expect(err.permission).toBe('permission' in row ? row.permission : null);
    expect(err.reason).toBe('reason' in row ? row.reason : null);

    const after = await gateRow(gate.id);
    expect(after).toMatchObject({ state: 'awaiting', decidedById: null, decidedAt: null });
    expect(await prRow(pr.id)).toMatchObject({ mergeAuthority: null, mergeOutcomeRef: null });
  });

  it('a host that does not ANSWER decides nothing, and is logged with the gate id', async () => {
    const assignee = await seatedOn('member');
    const { gate } = await mergeGateFor(assignee.user.id);
    stubSeam(new MergeChangeRequestError('github', 'timeout'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      pullRequestMergeService.approveMergeGate({ gateId: gate.id, source: 'ui' }, assignee.ctx),
    ).rejects.toBeInstanceOf(MergeChangeRequestError);

    expect((await gateRow(gate.id)).state).toBe('awaiting');
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('did not answer'),
      expect.objectContaining({ gateId: gate.id }),
    );
  });
});

describe('a CHANGED subject supersedes the gate and calls no host', () => {
  const CHANGES: Array<{ name: string; change: (pr: { id: string }) => Promise<unknown> }> = [
    {
      name: 'the head moved',
      change: (pr) =>
        adminDb.githubCheckRun.create({
          data: {
            pullRequestId: pr.id,
            commitSha: 'a-newer-head',
            checkName: 'Vitest',
            conclusion: 'pending',
          },
        }),
    },
    {
      name: 'the pull request closed',
      change: (pr) =>
        adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { state: 'closed' } }),
    },
    {
      name: 'its delivery row is gone',
      change: (pr) =>
        adminDb.workItemDelivery.deleteMany({ where: { githubPullRequestId: pr.id } }),
    },
  ];

  it.each(CHANGES)('$name → APPROVAL_GATE_SUPERSEDED, zero seam calls', async ({ change }) => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await mergeGateFor(assignee.user.id);
    await change(pr);
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.approveMergeGate({ gateId: gate.id, source: 'ui' }, assignee.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);

    expect(seam).not.toHaveBeenCalled();
    expect((await gateRow(gate.id)).state).toBe('superseded');
  });

  it('a seam subject_changed (the 409 that raced the check) supersedes the same way', async () => {
    const assignee = await seatedOn('member');
    const { gate } = await mergeGateFor(assignee.user.id);
    stubSeam({ outcome: 'refused', refusal: { code: 'subject_changed' } });

    await expect(
      pullRequestMergeService.approveMergeGate({ gateId: gate.id, source: 'ui' }, assignee.ctx),
    ).rejects.toBeInstanceOf(ApprovalGateSupersededError);
    expect((await gateRow(gate.id)).state).toBe('superseded');
  });
});

describe('the actor and the other verb', () => {
  it('an actor without authority is refused with zero seam calls', async () => {
    const assignee = await seatedOn('member');
    const bystander = await seatedOn('member');
    const { gate } = await mergeGateFor(assignee.user.id);
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    await expect(
      pullRequestMergeService.decideGate(
        { gateId: gate.id, decision: 'approve', source: 'ui' },
        bystander.ctx,
      ),
    ).rejects.toBeInstanceOf(ApprovalGateNotAuthorisedError);
    expect(seam).not.toHaveBeenCalled();
    expect((await gateRow(gate.id)).state).toBe('awaiting');
  });

  it('request_changes on a merge gate calls no host and records the decision', async () => {
    const assignee = await seatedOn('member');
    const { gate } = await mergeGateFor(assignee.user.id);
    const seam = vi.spyOn(github, 'mergeChangeRequest');

    const result = await pullRequestMergeService.decideGate(
      { gateId: gate.id, decision: 'request_changes', noteMd: 'Not yet', source: 'ui' },
      assignee.ctx,
    );

    expect(seam).not.toHaveBeenCalled();
    expect(result.gate.state).toBe('changes_requested');
  });
});

describe('two presses at once', () => {
  it('one merges and decides; the other is refused — one decided gate, one merge record, no 500', async () => {
    const assignee = await seatedOn('member');
    const { pr, gate } = await mergeGateFor(assignee.user.id);
    stubSeam(
      { outcome: 'merged', commitSha: 'c0ffee' },
      { outcome: 'refused', refusal: { code: 'already_merged' } },
    );

    const press = () =>
      pullRequestMergeService.decideGate(
        { gateId: gate.id, decision: 'approve', source: 'ui' },
        assignee.ctx,
      );
    const outcomes = await Promise.allSettled([press(), press()]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A typed refusal — the frame draws it — never an unclassified error.
    expect(rejected[0]!.reason).toBeInstanceOf(ApprovalGateError);

    expect((await gateRow(gate.id)).state).toBe('approved');
    expect(await prRow(pr.id)).toMatchObject({
      mergeAuthority: 'gate',
      mergeOutcomeRef: 'c0ffee',
    });
  });
});
