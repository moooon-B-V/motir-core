import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildProjection } from '@/lib/services/planProjectionService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import {
  DuplicatePlanTargetError,
  PlanGrammarError,
  PlanProposalReferencedError,
  PlanRefGraphError,
} from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { contentRevisions } from '../../helpers/planTargetRevisions';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-6057 — Story MOTIR-6013's motir-core INTEGRATION gate, against real
// Postgres (no mocks of plansService / planRepository / planItemRepository).
//
// Each feature child tested its own function: the re-parent under a proposal
// (MOTIR-6050), the merge of a second modify (MOTIR-6051), a remove's reason
// (MOTIR-6052) and the review naming both (MOTIR-6055). What this suite owns is
// the SEAMS between them, exercised with all three shapes in ONE plan:
// append → correction / withdraw → projection and `validate_plan` → the review
// model → approve / `materialize`. `agent-authored-plans.md` AMENDMENT 18
// (the cards cite it as 17).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Kind = 'epic' | 'story' | 'task' | 'subtask';

async function seed(fx: WorkItemFixture, title: string, kind: Kind, parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

async function openPlan(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Surgical' }, fx.ctx)).id;
}

/** Run `fn`, return what it threw (and fail if it threw nothing). */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  const thrown = await fn().then(
    () => undefined,
    (err: unknown) => err as Error,
  );
  expect(thrown, 'the call must be rejected').toBeInstanceOf(Error);
  return thrown!;
}

const ref = (planItemId: string): string => `${TEMP_REF_PREFIX}${planItemId}`;

/**
 * The story's shape in one plan: epic E1 holds X's home story; epic E2 is
 * where the plan ADDS story S; X is MOVED under S and, in a SECOND append,
 * edited again (the merge); Y is REMOVED with a reason.
 */
async function threeShapePlan(fx: WorkItemFixture) {
  const e1 = await seed(fx, 'Billing', 'epic');
  const home = await seed(fx, 'Invoices', 'story', e1.id);
  const x = await seed(fx, 'Retry a failed delivery', 'task', home.id);
  const e2 = await seed(fx, 'Webhooks', 'epic');
  const y = await seed(fx, 'Legacy CSV export', 'task', home.id);

  const planId = await openPlan(fx);
  const first = await plansService.addProposals(
    planId,
    [
      {
        op: 'add',
        parentRef: e2.id,
        proposedFields: { title: 'Delivery guarantees', kind: 'story' },
      },
    ],
    fx.ctx,
  );
  const s = first.appendedItemIds[0]!;
  const moved = await plansService.addProposals(
    planId,
    [
      { op: 'modify', workItemId: x.id, patch: { parentRef: ref(s) } },
      { op: 'remove', workItemId: y.id, reason: '  Replaced by the JSON export.  ' },
    ],
    fx.ctx,
  );
  const modifyId = moved.appendedItemIds[0]!;
  const edited = await plansService.addProposals(
    planId,
    [
      {
        op: 'modify',
        workItemId: x.id,
        patch: { descriptionMd: '## Acceptance criteria\n\n- A retry is idempotent.' },
      },
    ],
    fx.ctx,
  );
  return { planId, e1, e2, home, x, y, s, modifyId, mergedId: edited.appendedItemIds[0]! };
}

describe('ONE plan, all three shapes — append → project → validate → review → approve', () => {
  it('holds ONE merged modify, projects X under S, validates, and names S and Y’s reason', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, x, y, s, modifyId, mergedId } = await threeShapePlan(fx);

    // The append: the second modify of X merged into the first — ONE row,
    // carrying BOTH the move and the body, and the merge returned its id.
    expect(mergedId).toBe(modifyId);
    const modifies = await adminDb.planItem.findMany({ where: { planId, op: 'modify' } });
    expect(modifies).toHaveLength(1);
    expect(modifies[0]!.patch).toEqual({
      parentRef: ref(s),
      descriptionMd: '## Acceptance criteria\n\n- A retry is idempotent.',
    });

    // The projection places X under the proposed story.
    const proj = await buildProjection(planId, fx.ctx);
    expect(proj.nodes.get(x.id)!.parentId).toBe(ref(s));

    // `validate_plan`'s verdict: approvable.
    expect(await plansService.checkApprovability(planId, fx.ctx)).toEqual([]);

    // The review model names S by its title on X's row, and carries Y's reason.
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const xRow = review.items.find((i) => i.op === 'modify')!;
    const parentChange = xRow.changes.find((c) => c.field === 'parent')!;
    expect(parentChange.to).toBe('Delivery guarantees');
    expect(parentChange.placement?.to).toMatchObject({ proposedTitle: 'Delivery guarantees' });
    expect(xRow.changes.map((c) => c.field)).toEqual(
      expect.arrayContaining(['parent', 'description']),
    );
    const yRow = review.items.find((i) => i.op === 'remove')!;
    expect(yRow.identifier).toBe(y.identifier);
    expect(yRow.removeReason).toBe('Replaced by the JSON export.');
  });

  it('APPROVE creates S, lands X under it with its body, and archives Y with its reason', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, e2, home, x, y } = await threeShapePlan(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    const s = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, title: 'Delivery guarantees' },
    });
    expect(s.kind).toBe('story');
    expect(s.parentId).toBe(e2.id);

    const xAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: x.id } });
    expect(xAfter.parentId).toBe(s.id);
    expect(xAfter.descriptionMd).toBe('## Acceptance criteria\n\n- A retry is idempotent.');
    expect(xAfter.archivedAt).toBeNull();
    // ONE content revision for the merged modify, carrying both cells.
    const xRevisions = await contentRevisions(x.id);
    expect(xRevisions).toHaveLength(1);
    const diff = xRevisions[0]!.diff as Record<string, unknown>;
    expect(diff.parentId).toEqual({ from: home.id, to: s.id });
    expect(diff).toHaveProperty('descriptionMd');

    const yAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: y.id } });
    expect(yAfter.archivedAt).not.toBeNull();
    const archived = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: y.id, changeKind: 'archived' },
    });
    expect(archived.diff).toEqual({ reason: 'Replaced by the JSON export.' });

    // After approve the review names the created key, not the proposed title.
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const parentChange = review.items
      .find((i) => i.op === 'modify')!
      .changes.find((c) => c.field === 'parent')!;
    expect(parentChange.to).toBe(s.identifier);
  });
});

describe('the seams between the children', () => {
  it('MERGE × RE-PARENT: the merged row is what the gate judges — a cycle its second half closes is refused at a revision append, and the move survives', async () => {
    const fx = await makeWorkItemFixture();
    const e = await seed(fx, 'The epic', 'epic');
    const x = await seed(fx, 'X', 'story', e.id);
    const planId = await openPlan(fx);
    const added = await plansService.addProposals(
      planId,
      [
        { op: 'add', parentRef: e.id, proposedFields: { title: 'S', kind: 'story' } },
        {
          op: 'add',
          parentRef: e.id,
          proposedFields: { title: 'T', kind: 'task' },
          blockedByRefs: [x.id],
        },
      ],
      fx.ctx,
    );
    const [s, t] = added.appendedItemIds as [string, string];
    // A move under the proposed story S (a task, which a story may hold), and a
    // first modify of X that says nothing about edges — each legal alone.
    const task = await seed(fx, 'The task', 'task', x.id);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: task.id, patch: { parentRef: ref(s) } }],
      fx.ctx,
    );
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: x.id, patch: { title: 'X renamed' } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);

    // Second half, merged into X's row: X waits on T while T waits on X.
    const refusal = await rejection(() =>
      plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: x.id, patch: { blockedByAdd: [ref(t)] } }],
        fx.ctx,
        { revision: true },
      ),
    );
    expect(refusal).toBeInstanceOf(PlanRefGraphError);
    expect((refusal as PlanRefGraphError).reason).toBe('cycle');
    const rows = await adminDb.planItem.findMany({ where: { planId, op: 'modify' } });
    const byTarget = Object.fromEntries(rows.map((r) => [r.workItemId, r.patch]));
    expect(byTarget[x.id]).toEqual({ title: 'X renamed' });
    expect(byTarget[task.id]).toEqual({ parentRef: ref(s) });
  });

  it('WITHDRAW: S cannot go while the MERGED modify points at it; withdrawing the modify frees it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, s, modifyId } = await threeShapePlan(fx);

    const refused = await rejection(() => plansService.withdrawProposal(planId, s, fx.ctx));
    expect(refused).toBeInstanceOf(PlanProposalReferencedError);
    expect((refused as PlanProposalReferencedError).referrers).toEqual([modifyId]);

    await plansService.withdrawProposal(planId, modifyId, fx.ctx);
    await plansService.withdrawProposal(planId, s, fx.ctx);
    const left = await adminDb.planItem.findMany({ where: { planId } });
    expect(left.map((r) => r.op)).toEqual(['remove']);
  });

  it('CORRECTION: a legal proposed parent persists, an illegal one is refused and leaves the patch', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, e2, modifyId } = await threeShapePlan(fx);
    const other = await plansService.addProposals(
      planId,
      [
        { op: 'add', parentRef: e2.id, proposedFields: { title: 'Another story', kind: 'story' } },
        {
          op: 'add',
          parentRef: e2.id,
          proposedFields: { title: 'An epic-level task', kind: 'task' },
        },
      ],
      fx.ctx,
    );
    const [story2, task2] = other.appendedItemIds as [string, string];
    const sub = await plansService.addProposals(
      planId,
      [{ op: 'add', parentRef: ref(task2), proposedFields: { title: 'A step', kind: 'subtask' } }],
      fx.ctx,
    );

    await plansService.correctProposal(
      planId,
      modifyId,
      { patch: { parentRef: ref(story2) } },
      fx.ctx,
    );
    let stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } });
    expect((stored.patch as { parentRef: string }).parentRef).toBe(ref(story2));

    // A task may not hang under a proposed SUBTASK.
    const refused = await rejection(() =>
      plansService.correctProposal(
        planId,
        modifyId,
        { patch: { parentRef: ref(sub.appendedItemIds[0]!) } },
        fx.ctx,
      ),
    );
    expect(refused).toBeInstanceOf(PlanGrammarError);
    expect((refused as PlanGrammarError).reason).toBe('illegal_parent');
    stored = await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } });
    expect((stored.patch as { parentRef: string }).parentRef).toBe(ref(story2));
  });

  it('REVISION: a second modify on a `planned` plan merges into the row, and the plan stays planned', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, x, s, modifyId } = await threeShapePlan(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const revised = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: x.id, patch: { title: 'Retry, idempotently' } }],
      fx.ctx,
      { revision: true },
    );
    expect(revised.appendedItemIds).toEqual([modifyId]);
    expect(revised.status).toBe('planned');
    const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: modifyId } });
    expect(row.patch).toMatchObject({ parentRef: ref(s), title: 'Retry, idempotently' });
  });
});

describe('the refusals that still stand', () => {
  it('a modify and a remove of one card — either order, across two appends', async () => {
    const fx = await makeWorkItemFixture();
    // One card per order: a second plan may not touch a card the first holds.
    const card = await seed(fx, 'Contested', 'task');
    const other = await seed(fx, 'Also contested', 'task');

    const a = await openPlan(fx);
    await plansService.addProposals(
      a,
      [{ op: 'modify', workItemId: card.id, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    expect(
      await rejection(() =>
        plansService.addProposals(a, [{ op: 'remove', workItemId: card.id }], fx.ctx),
      ),
    ).toBeInstanceOf(DuplicatePlanTargetError);

    const b = await openPlan(fx);
    await plansService.addProposals(
      b,
      [{ op: 'remove', workItemId: other.id, reason: 'Gone.' }],
      fx.ctx,
    );
    expect(
      await rejection(() =>
        plansService.addProposals(
          b,
          [{ op: 'modify', workItemId: other.id, patch: { title: 'Renamed' } }],
          fx.ctx,
        ),
      ),
    ).toBeInstanceOf(DuplicatePlanTargetError);
  });

  it('a move under a proposal whose KIND cannot parent the card: refused at the append, and at approve when forced past it', async () => {
    const fx = await makeWorkItemFixture();
    const e = await seed(fx, 'The epic', 'epic');
    const home = await seed(fx, 'Home', 'story', e.id);
    const card = await seed(fx, 'A task', 'task', home.id);
    const planId = await openPlan(fx);
    const added = await plansService.addProposals(
      planId,
      [
        { op: 'add', parentRef: e.id, proposedFields: { title: 'Legal story', kind: 'story' } },
        { op: 'add', parentRef: e.id, proposedFields: { title: 'A task', kind: 'task' } },
      ],
      fx.ctx,
    );
    const [story, task] = added.appendedItemIds as [string, string];
    const sub = (
      await plansService.addProposals(
        planId,
        [{ op: 'add', parentRef: ref(task), proposedFields: { title: 'Step', kind: 'subtask' } }],
        fx.ctx,
      )
    ).appendedItemIds[0]!;

    const atAppend = await rejection(() =>
      plansService.addProposals(
        planId,
        [{ op: 'modify', workItemId: card.id, patch: { parentRef: ref(sub) } }],
        fx.ctx,
      ),
    );
    expect(atAppend).toBeInstanceOf(PlanGrammarError);

    // Forced past every door that runs the gate — the stored row rewritten
    // underneath — approve re-takes the verdict and refuses.
    const legal = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: card.id, patch: { parentRef: ref(story) } }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await adminDb.planItem.update({
      where: { id: legal.appendedItemIds[0]! },
      data: { patch: { parentRef: ref(sub) } },
    });
    const atApprove = await rejection(() => plansService.approvePlan(planId, fx.ctx));
    expect(atApprove.name).not.toBe('PrismaClientKnownRequestError');
    expect(await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      parentId: home.id,
    });
  });
});

describe('referrer truth — a removed blocker', () => {
  it('approve archives the blocker and leaves the dependent’s edge exactly as it stands today', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await seed(fx, 'Obsolete blocker', 'task');
    const dependent = await seed(fx, 'Still to do', 'task');
    await workItemsService.linkWorkItems(
      { fromId: dependent.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'remove', workItemId: blocker.id, reason: 'Superseded.' }],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: blocker.id } })).archivedAt,
    ).not.toBeNull();
    // Core does not sweep the referrer — that is the planner's job (MOTIR-6063).
    const edges = await adminDb.workItemLink.findMany({
      where: { fromId: dependent.id, toId: blocker.id },
    });
    expect(edges).toHaveLength(1);
  });
});
