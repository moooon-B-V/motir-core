import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// `approvalGatesService.listHeldTransitions` (Story MOTIR-4887 · Subtask MOTIR-5528)
// on real Postgres — the read the item page, quick view and edit page lock their
// status moves from. It must say exactly what the guard would refuse.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function cardInReview(opts: { gateKind?: ApprovalGateKind; reporterId?: string } = {}) {
  seq += 1;
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: `S${seq}` },
    fx.ctx,
  );
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: `D${seq}` },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  if (opts.reporterId) {
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { reporterId: opts.reporterId },
    });
  }
  if (opts.gateKind) {
    await withWorkspaceContext(fx.ctx, (tx) =>
      approvalGateRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: item.id,
          kind: opts.gateKind!,
          subjectId: `subject-${item.id}`,
        },
        tx,
      ),
    );
  }
  return item;
}

async function openPullRequestOn(itemId: string) {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-${itemId}`,
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
      repoId: `repo-${itemId}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 3,
      title: 'pr',
      state: 'open',
      headRef: 'h',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: itemId,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
}

describe('listHeldTransitions', () => {
  it('a registered design gate awaiting, no pull request → ONE Done row, decidable by the owner', async () => {
    const item = await cardInReview({ gateKind: 'design_result' });

    const rows = await approvalGatesService.listHeldTransitions(item.id, fx.ctx);

    expect(rows).toEqual([
      expect.objectContaining({
        statusKey: 'done',
        statusLabel: 'Done',
        waitingOn: 'decision',
        kind: 'design_result',
        canDecide: true,
      }),
    ]);
    expect(rows[0]!.gateId).not.toBeNull();
  });

  it('a reader who may not decide gets the row with canDecide false and the routed-to name', async () => {
    const reporter = await createTestUser({ name: 'Rita Reporter' });
    await adminDb.workspaceMembership.create({
      data: { userId: reporter.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    const item = await cardInReview({ gateKind: 'design_result', reporterId: reporter.id });
    const bystander = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: bystander.id, workspaceId: fx.workspaceId, role: 'member' },
    });

    const rows = await approvalGatesService.listHeldTransitions(item.id, {
      userId: bystander.id,
      workspaceId: fx.workspaceId,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ canDecide: false, routedToLabel: 'Rita Reporter' });
  });

  it('an UNREGISTERED kind awaiting, no pull request → no row', async () => {
    const item = await cardInReview({ gateKind: 'pull_request_merge' });
    expect(await approvalGatesService.listHeldTransitions(item.id, fx.ctx)).toEqual([]);
  });

  it('no gate and no pull request → no row', async () => {
    const item = await cardInReview();
    expect(await approvalGatesService.listHeldTransitions(item.id, fx.ctx)).toEqual([]);
  });

  it('an open pull request, no gate raised → Approved (decision, not decidable) and Done (merge)', async () => {
    const item = await cardInReview();
    await openPullRequestOn(item.id);

    const rows = await approvalGatesService.listHeldTransitions(item.id, fx.ctx);

    expect(rows.map((r) => [r.statusKey, r.waitingOn, r.gateId, r.canDecide])).toEqual([
      ['approved', 'decision', null, false],
      ['done', 'merge', null, false],
    ]);
  });

  it('an open pull request with an UNREGISTERED gate awaiting → its rows carry that kind, routed by the card', async () => {
    // With a pull request open the held moves carry the awaiting gate's kind, and a kind with
    // no handler routes by the card itself. `pull_request_approval` walked this fallback until
    // MOTIR-5481 registered it; `decision_approval` is the one kind still a hole (MOTIR-4907).
    const item = await cardInReview({ gateKind: 'decision_approval' });
    await openPullRequestOn(item.id);

    const rows = await approvalGatesService.listHeldTransitions(item.id, fx.ctx);

    expect(rows.map((r) => [r.statusKey, r.waitingOn, r.kind])).toEqual([
      ['approved', 'decision', 'decision_approval'],
      ['done', 'merge', 'decision_approval'],
    ]);
    expect(rows[0]!.gateId).not.toBeNull();
    expect(rows[0]!.routedToLabel).not.toBeNull();
  });

  it('never lists the status the card already has — at Approved, only Done is held', async () => {
    const item = await cardInReview();
    await openPullRequestOn(item.id);
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'approved' } });

    const rows = await approvalGatesService.listHeldTransitions(item.id, fx.ctx);

    expect(rows.map((r) => r.statusKey)).toEqual(['done']);
  });

  it('agrees with the guard: every listed move is refused by the door', async () => {
    const item = await cardInReview({ gateKind: 'design_result' });
    const rows = await approvalGatesService.listHeldTransitions(item.id, fx.ctx);
    for (const row of rows) {
      await expect(
        workItemsService.updateStatus(item.id, row.statusKey, fx.ctx),
      ).rejects.toMatchObject({
        code: 'APPROVAL_GATE_PENDING',
      });
    }
  });
});
