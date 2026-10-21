import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE `manual_work` QUESTION LEAVES A CARD A PERSON CAN NO LONGER START (Bug MOTIR-8670;
// `docs/decisions/manual-work-gate.md` §6, AMENDED 2026-10-15). Real Postgres, the real
// services. The production shape: a run raised the gate on MOTIR-8529, a re-plan then
// rewrote the card and blocked it on a new, unstarted card, and the gate stayed
// `awaiting` — so Waiting on you asked the person to mark done work they could not
// start, about a body that was no longer the one shown.
//
// Withdrawn by: a plan approval that changes the card's body or adds an open blocker,
// a park or move to Planning (`replanned`), a move to Blocked, and an open `blocked_by`
// added by any link door (`not_ready`). Kept by: an edit to a field the stamp does not
// hash, and a `blocked_by` to finished work. Never re-raised by the withdrawal: the next
// run that reaches the card raises it again.

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { plansService } = await import('@/lib/services/plansService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { manualWorkGateService } = await import('@/lib/services/manualWorkGateService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function manualCard() {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Review the word list ${seq}`,
      descriptionMd: 'Read the sheet and record one verdict.',
      type: 'review',
      executor: 'human',
      assigneeId: fx.ownerId,
    },
    fx.ctx,
  );
}

async function agentCard(title = 'Prepare the review sheet') {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, type: 'code' },
    fx.ctx,
  );
}

function raise(workItemId: string) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    manualWorkGateService.raise(workItemId, { createdById: fx.ownerId }, fx.workspaceId, tx),
  );
}

async function raisedCard() {
  const card = await manualCard();
  expect((await raise(card.id)).raised).toBe(true);
  return card;
}

const gatesOf = (workItemId: string) =>
  adminDb.approvalGate.findMany({
    where: { workItemId, kind: 'manual_work' },
    orderBy: { createdAt: 'asc' },
  });

const awaitingOf = async (workItemId: string) =>
  (await gatesOf(workItemId)).filter((g) => g.state === 'awaiting');

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

/** The Workbench's Waiting on you list, as the routed person reads it. */
async function waitingOnYou(): Promise<string[]> {
  const tab = await approvalGatesService.listAwaitingMe({ ...fx.ctx, projectId: fx.projectId });
  return tab.items.map((row) => row.workItem?.id ?? '');
}

async function plannedModify(workItemId: string, patch: Record<string, unknown>) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('a re-plan withdraws the question (`replanned`)', () => {
  it(
    'the production shape: a plan rewrites the card and blocks it on new work — no awaiting gate, and it leaves Waiting on you',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await raisedCard();
      const prerequisite = await agentCard();
      expect(await waitingOnYou()).toContain(card.id);

      const planId = await plannedModify(card.id, {
        descriptionMd: 'Read the prepared sheet, at a named commit, and record one verdict.',
        blockedByAdd: [prerequisite.id],
      });
      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('blocked');
      expect(await awaitingOf(card.id)).toHaveLength(0);
      expect(await gatesOf(card.id)).toEqual([
        expect.objectContaining({ state: 'superseded', supersededCause: 'replanned' }),
      ]);
      expect(await waitingOnYou()).not.toContain(card.id);
    },
  );

  it(
    'a body rewrite with no new blocker is withdrawn too — the card the run reached is not the card as planned',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await raisedCard();

      const planId = await plannedModify(card.id, { descriptionMd: 'A different review.' });
      await plansService.approvePlan(planId, fx.ctx);

      expect(await statusOf(card.id)).toBe('todo');
      expect(await gatesOf(card.id)).toEqual([
        expect.objectContaining({ state: 'superseded', supersededCause: 'replanned' }),
      ]);
    },
  );

  it(
    'the approve withdraws it even when the append parked nothing (a card already at Planning by hand)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await raisedCard();
      // Hand-parked BEFORE this fix shipped: the move wrote no withdrawal, so the
      // gate is still awaiting on a card at Planning — the state production holds.
      await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'planning' } });
      expect(await awaitingOf(card.id)).toHaveLength(1);

      const planId = await plannedModify(card.id, { title: 'Review the word list, again' });
      expect(await awaitingOf(card.id)).toHaveLength(1);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await gatesOf(card.id)).toEqual([
        expect.objectContaining({ state: 'superseded', supersededCause: 'replanned' }),
      ]);
    },
  );

  it('a move to Planning withdraws it in the move’s transaction', async () => {
    const card = await raisedCard();

    await workItemsService.updateStatus(card.id, 'planning', fx.ctx);

    expect(await gatesOf(card.id)).toEqual([
      expect.objectContaining({ state: 'superseded', supersededCause: 'replanned' }),
    ]);
  });
});

describe('a card that stops being ready withdraws the question (`not_ready`)', () => {
  it('a move to Blocked withdraws it, and the row leaves Waiting on you', async () => {
    const card = await raisedCard();

    await workItemsService.updateStatus(card.id, 'blocked', fx.ctx);

    expect(await gatesOf(card.id)).toEqual([
      expect.objectContaining({ state: 'superseded', supersededCause: 'not_ready' }),
    ]);
    expect(await waitingOnYou()).not.toContain(card.id);
  });

  it('an open `blocked_by` added through the link door withdraws it', async () => {
    const card = await raisedCard();
    const blocker = await agentCard();

    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expect(await gatesOf(card.id)).toEqual([
      expect.objectContaining({ state: 'superseded', supersededCause: 'not_ready' }),
    ]);
  });

  it('a new card created as BLOCKING it withdraws it, in the create’s transaction', async () => {
    const card = await raisedCard();

    await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'A prerequisite filed later',
        type: 'code',
        links: [{ relationship: 'blocks', targetId: card.id }],
      },
      fx.ctx,
    );

    expect(await gatesOf(card.id)).toEqual([
      expect.objectContaining({ state: 'superseded', supersededCause: 'not_ready' }),
    ]);
  });

  it(
    'a plan that only adds an open blocker to a card it could not park withdraws it on approve',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await raisedCard();
      const blocker = await agentCard();
      // No edge into Planning from here, so the append parks nothing and the gate
      // survives the append; the approve's edge is what must withdraw it.
      await adminDb.workflowTransition.deleteMany({
        where: {
          projectId: fx.projectId,
          toStatus: { key: 'planning' },
        },
      });

      const planId = await plannedModify(card.id, { blockedByAdd: [blocker.id] });
      expect(await statusOf(card.id)).toBe('todo');
      expect(await awaitingOf(card.id)).toHaveLength(1);
      await plansService.approvePlan(planId, fx.ctx);

      expect(await gatesOf(card.id)).toEqual([
        expect.objectContaining({ state: 'superseded', supersededCause: 'not_ready' }),
      ]);
    },
  );
});

describe('a card still ready and unchanged keeps the question', () => {
  it('an assignee or priority edit withdraws nothing', async () => {
    const card = await raisedCard();
    await workItemsService.updateWorkItem(card.id, { priority: 'high' }, fx.ctx);
    await workItemsService.updateWorkItem(card.id, { assigneeId: null }, fx.ctx);

    expect(await awaitingOf(card.id)).toHaveLength(1);
  });

  it('a `blocked_by` on FINISHED work withdraws nothing', async () => {
    const card = await raisedCard();
    const blocker = await agentCard('Already shipped');
    await adminDb.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });

    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expect(await awaitingOf(card.id)).toHaveLength(1);
  });

  it('a move to In Progress withdraws nothing — the person may be doing the work', async () => {
    const card = await raisedCard();
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    expect(await awaitingOf(card.id)).toHaveLength(1);
  });

  it('the card a link BLOCKS keeps its own question — only the blocked end lost readiness', async () => {
    const card = await raisedCard();
    const dependent = await agentCard('Waits on the review');

    await workItemsService.linkWorkItems(
      { fromId: dependent.id, toId: card.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    expect(await awaitingOf(card.id)).toHaveLength(1);
  });
});

describe('after a withdrawal, the next run raises it again — and nothing else does', () => {
  it('no gate while the card waits, and a fresh awaiting gate once a run reaches it ready', async () => {
    const card = await raisedCard();
    const blocker = await agentCard();
    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    expect(await awaitingOf(card.id)).toHaveLength(0);

    // The prerequisite finishes. Nothing re-asks on its own.
    await adminDb.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });
    expect(await awaitingOf(card.id)).toHaveLength(0);

    // A run reaches the card, now ready.
    expect((await raise(card.id)).raised).toBe(true);
    const gates = await gatesOf(card.id);
    expect(gates.map((g) => g.state)).toEqual(['superseded', 'awaiting']);
    expect(await waitingOnYou()).toContain(card.id);
  });
});
