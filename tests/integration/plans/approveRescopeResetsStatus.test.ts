import { type GithubRepo } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planRevisionsService } from '@/lib/services/planRevisionsService';
import { planReviewService } from '@/lib/services/planReviewService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanItemPatch } from '@/lib/dto/plans';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';
import { organizationIdOf } from '../../helpers/organizationOf';

// Bug MOTIR-5359 — approving a plan whose `modify` RE-SCOPES a card in the
// `in_progress` status category walks it back to the project's initial status,
// against real Postgres through the approve service (no mocks, per CLAUDE.md).
//
// Before the fix `applyModify` rewrote the title / body / repository and left the
// status alone, so an `implemented` card went on claiming that code matching the
// OLD body was on the remote — and readiness, the board, the parent rollup and
// dispatch all read that claim. Seen on re-plan `cmtzt40xf001vhvoiebhv0nn6`,
// whose six re-scoped cards stayed `implemented` until they were rolled back by
// hand.
//
// What is pinned here:
//   1. `title`, `descriptionMd` and a repository re-pin each RESET an
//      `implemented` card, on the modify's ONE revision, naming the plan.
//   2. Every in-progress-category status resets, and the ARM is recorded: the
//      default workflow declares `in_progress → todo`, and declares no edge to
//      `todo` from `implemented` / `in_review` / `approved`.
//   3. The EXCLUDED patches — type, sizing, edges, priority — leave the status.
//   4. `todo` and `done` targets are not touched.
//   5. The reset is INSIDE the approve transaction.
//   6. The review diff shows the reset before approve, and only for a re-scope.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(fx: WorkItemFixture, title = 'The card'): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return dto.id;
}

/** Put a card at `status` without walking the workflow — the statuses past
 *  `implemented` are written by CI and by gates, not by a person's move. */
async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function approveModify(
  fx: WorkItemFixture,
  workItemId: string,
  patch: PlanItemPatch,
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  await plansService.approvePlan(plan.id, fx.ctx);
  return plan.id;
}

async function row(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

async function modifyRevisionDiff(id: string): Promise<Record<string, unknown>> {
  const revisions = await adminDb.workItemRevision.findMany({
    where: { workItemId: id, changeKind: 'updated' },
    orderBy: { changedAt: 'asc' },
  });
  return revisions.at(-1)!.diff as Record<string, unknown>;
}

describe('approvePlan — a re-scoping `modify` resets an in-progress-category card', () => {
  it('an `implemented` card with a new description is at To Do after approve, with a revision naming the plan', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    // The reproduction the card names: todo → in_progress → implemented.
    await workItemsService.updateStatus(card, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(card, 'implemented', fx.ctx);
    await adminDb.workItem.update({ where: { id: card }, data: { sessionBranch: 'subtask/old' } });

    const planId = await approveModify(fx, card, { descriptionMd: 'A different body.' });

    const after = await row(card);
    expect(after.descriptionMd).toBe('A different body.');
    expect(after.status).toBe('todo');
    // The integration branch goes with the claim — readiness would otherwise treat
    // the reset card as satisfied for its dependents.
    expect(after.sessionBranch).toBeNull();

    const diff = await modifyRevisionDiff(card);
    expect(diff.status).toEqual({ from: 'implemented', to: 'todo' });
    expect(diff.statusReset).toEqual({ planId, reason: 'rescoped', arm: 'plan_reset' });
    // ONE revision for the whole modify: the body and the status ride the same row.
    expect(diff.descriptionMd).toBeDefined();
  });

  it('a `title` patch resets too', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    await approveModify(fx, card, { title: 'A re-scoped title' });

    const after = await row(card);
    expect(after.title).toBe('A re-scoped title');
    expect(after.status).toBe('todo');
  });

  it('a target-repository patch resets too', async () => {
    const fx = await makeWorkItemFixture();
    await establishRepo(fx, 'acme-web', 'web');
    await establishRepo(fx, 'acme-api', 'api');
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    await approveModify(fx, card, { targetRepo: 'acme-api' });

    const after = await row(card);
    expect(after.targetRepo).toBe('acme-api');
    expect(after.status).toBe('todo');
  });

  it.each([
    // The default workflow DECLARES `in_progress → todo`: an ordinary transition.
    ['in_progress', 'transition'],
    // …and declares no edge to `todo` from these: the plan-driven reset arm.
    ['in_review', 'plan_reset'],
    ['approved', 'plan_reset'],
  ])('a `%s` target resets, on the `%s` arm', async (status, arm) => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, status);

    const planId = await approveModify(fx, card, { descriptionMd: 'Re-scoped.' });

    expect((await row(card)).status).toBe('todo');
    const diff = await modifyRevisionDiff(card);
    expect(diff.status).toEqual({ from: status, to: 'todo' });
    expect(diff.statusReset).toEqual({ planId, reason: 'rescoped', arm });
  });

  it.each<[string, PlanItemPatch]>([
    ['type-only', { type: 'design' }],
    ['estimateMinutes-only', { estimateMinutes: 90 }],
    ['storyPoints-only', { storyPoints: 5 }],
    ['priority-only', { priority: 'high' }],
    ['blockedByAdd-only', { blockedByAdd: ['__BLOCKER__'] }],
    ['blockedByRemove-only', { blockedByRemove: ['__BLOCKER__'] }],
  ])('an `implemented` target KEEPS its status after a %s patch', async (_label, patch) => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    const blocker = await seedCard(fx, 'A blocker');
    if (patch.blockedByRemove) {
      await workItemsService.linkWorkItems(
        { fromId: card, toId: blocker, kind: 'is_blocked_by' },
        fx.ctx,
      );
    }
    await setStatus(card, 'implemented');
    const resolved = JSON.parse(JSON.stringify(patch).replaceAll('__BLOCKER__', blocker));

    await approveModify(fx, card, resolved);

    expect((await row(card)).status).toBe('implemented');
    const diff = await modifyRevisionDiff(card);
    expect(diff.status).toBeUndefined();
    expect(diff.statusReset).toBeUndefined();
  });

  it('a `todo` target and a `done` target keep their statuses', async () => {
    const fx = await makeWorkItemFixture();
    const todo = await seedCard(fx, 'Not started');
    const done = await seedCard(fx, 'Finished');
    await setStatus(done, 'done');

    await approveModify(fx, todo, { descriptionMd: 'Re-scoped before anyone started.' });
    expect((await row(todo)).status).toBe('todo');
    expect((await modifyRevisionDiff(todo)).statusReset).toBeUndefined();

    // A re-scope of FINISHED work is refused by the persist gate before
    // materialize runs, so the reset never sees it — asserted as the status the
    // row still reads, whatever the approve answered.
    await approveModify(fx, done, { descriptionMd: 'Re-scoped after it shipped.' }).catch(
      () => undefined,
    );
    expect((await row(done)).status).toBe('done');
  });

  it('is ONE transaction: a failure after the reset rolls the status back too', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // The plan trail's `approved` row is written AFTER materialize, inside the
    // same transaction — so throwing there is a failure injected after the reset.
    const original = planRevisionsService.recordRevision.bind(planRevisionsService);
    vi.spyOn(planRevisionsService, 'recordRevision').mockImplementation(async (args, tx) => {
      if (args.changeKind === 'approved') throw new Error('injected after the reset');
      return original(args, tx);
    });

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toThrow(
      'injected after the reset',
    );

    const after = await row(card);
    expect(after.status).toBe('implemented');
    expect(after.descriptionMd).toBe('The old body.');
  });
});

describe('the review diff shows the reset BEFORE approve', () => {
  async function reviewChanges(fx: WorkItemFixture, workItemId: string, patch: PlanItemPatch) {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    return review.items.find((i) => i.op === 'modify')!.changes;
  }

  it('emits "status → To Do (re-scoped while Implemented)" for a re-scope of an implemented card', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    const changes = await reviewChanges(fx, card, { descriptionMd: 'A different body.' });

    expect(changes.find((c) => c.field === 'status')).toEqual({
      field: 'status',
      from: 'Implemented',
      to: 'To Do (re-scoped while Implemented)',
    });
  });

  it.each<[string, PlanItemPatch]>([
    ['type', { type: 'design' }],
    ['estimateMinutes', { estimateMinutes: 90 }],
    ['storyPoints', { storyPoints: 5 }],
    ['priority', { priority: 'high' }],
    ['explanationMd', { explanationMd: 'A new why.' }],
  ])('emits no status row for a %s-only patch', async (_label, patch) => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);
    await setStatus(card, 'implemented');

    const changes = await reviewChanges(fx, card, patch);

    expect(changes.find((c) => c.field === 'status')).toBeUndefined();
  });

  it('emits no status row for a re-scope of a `todo` card — there is nothing to reset', async () => {
    const fx = await makeWorkItemFixture();
    const card = await seedCard(fx);

    const changes = await reviewChanges(fx, card, { title: 'Re-scoped' });

    expect(changes.find((c) => c.field === 'status')).toBeUndefined();
  });
});

/** Connect one repo to the workspace and give the project an ESTABLISHED set row
 *  for it (mirrors `approvePlanTargetRepo.test.ts`). */
async function establishRepo(
  fx: WorkItemFixture,
  name: string,
  role: 'web' | 'api',
): Promise<void> {
  const setRow = await projectRepoSetService.addRow(fx.projectId, { role, name }, fx.ctx);
  const repo = await connectRepo(fx.workspaceId, name);
  await projectRepoSetService.attachRealizedRepo(setRow.id, repo.id, fx.ctx);
}

async function connectRepo(workspaceId: string, name: string): Promise<GithubRepo> {
  const installationId = `inst-${workspaceId}-github`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}
