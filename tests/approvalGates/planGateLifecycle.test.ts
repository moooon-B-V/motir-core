import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ApprovalGateStaleSubjectError } from '@/lib/approvalGates/errors';
import { PlanNotInExpectedStatusError } from '@/lib/plans/errors';
import { planRepository } from '@/lib/repositories/planRepository';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { planDriftService } from '@/lib/services/planDriftService';
import { planGateService } from '@/lib/services/planGateService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PLAN GATE IS RAISED AND SUPERSEDED WITH ITS PLAN (Story MOTIR-6012 · Subtask
// MOTIR-6036; ADR `approval-gates.md` §11.5, §11.5c, §11.7) — against a REAL Postgres,
// through the real `plansService` / `planDriftService` doors and the ONE decide door.
//
// Every gate here is written by the product: nothing is inserted by hand except where a
// case needs a plan that was `planned` BEFORE the raise shipped (the backfill's shape).

const HARNESS = { source: 'mcp' as const, harness: 'Claude Code', model: null };
const DONE = { fromStatusKey: 'in_progress', toStatusKey: 'done' };
const REVIVE = { fromStatusKey: 'done', toStatusKey: 'in_progress' };

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const gatesOf = (planId: string) =>
  adminDb.approvalGate.findMany({
    where: { kind: 'plan_approval', subjectId: planId },
    orderBy: { createdAt: 'asc' },
  });
const awaitingOf = async (planId: string) =>
  (await gatesOf(planId)).filter((g) => g.state === 'awaiting');
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });

/** A `generating` plan holding one `add` per title. */
async function draftPlan(titles: string[], createdById?: string) {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'A plan', authorSource: 'mcp', authorHarness: 'Claude Code', createdById },
    fx.ctx,
  );
  const itemIds: string[] = [];
  for (const title of titles) {
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
    itemIds.push(after.items[after.items.length - 1]!.id);
  }
  return { planId: plan.id, itemIds };
}

/** A plan CLOSED through `markPlanned`. */
async function closedPlan(titles: string[] = ['First', 'Second']) {
  const plan = await draftPlan(titles);
  await plansService.markPlanned(plan.planId, fx.ctx);
  return plan;
}

/** A closed plan proposing to `modify` a real work item — the drift fixture. */
async function planTargeting() {
  const target = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'A target' },
    fx.ctx,
  );
  const plan = await plansService.createPlan(fx.projectId, { title: 'Rework' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: target.id, patch: { title: 'New' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, targetId: target.id };
}

// ─── RAISED (§11.7 row 1) ────────────────────────────────────────────────────

describe('RAISED when a plan closes to `planned` with at least one proposal', () => {
  it('leaves exactly one awaiting gate, card-less, routed per §11.6 and stamped with the digest', async () => {
    const { planId } = await closedPlan();
    const gates = await gatesOf(planId);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      state: 'awaiting',
      workItemId: null,
      kind: 'plan_approval',
      subjectId: planId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      // No requester on this plan → the workspace OWNER (§11.6).
      routedToId: fx.ownerId,
    });
    expect(gates[0]!.subjectVersion).toMatch(/^plan\.v1\.[0-9a-f]{64}$/);
    // It is the gate the planning surface reads.
    const read = await approvalGatesService.getForPlan({ planId }, fx.ctx);
    expect(read.gate?.id).toBe(gates[0]!.id);
  });

  it('routes to the person who ASKED for the plan when there is one', async () => {
    const asker = await createTestUser({ email: 'asker@ex.com', name: 'Asker' });
    const { planId } = await draftPlan(['Only'], asker.id);
    await plansService.markPlanned(planId, fx.ctx);
    expect((await gatesOf(planId))[0]?.routedToId).toBe(asker.id);
  });

  it('closing twice leaves ONE — the second close is refused and a direct re-raise is a no-op', async () => {
    const { planId } = await closedPlan();
    await expect(plansService.markPlanned(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotInExpectedStatusError,
    );
    const plan = await planRow(planId);
    const again = await withWorkspaceContext(fx.ctx, (tx) => planGateService.raise(plan, tx));
    const gates = await gatesOf(planId);
    expect(gates).toHaveLength(1);
    expect(again).toEqual({ raised: false, gate: expect.objectContaining({ id: gates[0]!.id }) });
  });

  it('an EMPTY close raises nothing — the plan is discarded, not asked', async () => {
    const { planId } = await draftPlan([]);
    await plansService.markPlanned(planId, fx.ctx);
    expect(await planRow(planId)).toMatchObject({
      status: 'declined',
      decisionReason: 'discarded',
    });
    expect(await gatesOf(planId)).toEqual([]);
  });

  it('`raise` asks nothing of a plan that is not `planned`, or one holding no proposal', async () => {
    const { planId } = await draftPlan(['Still generating']);
    const generating = await planRow(planId);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) => planGateService.raise(generating, tx)),
    ).toEqual({ raised: false });

    // A `planned` plan with no proposals cannot be reached through the doors (the
    // empty close and the last withdrawal both end it), so it is forged here.
    const { planId: emptyId } = await draftPlan([]);
    await adminDb.plan.update({ where: { id: emptyId }, data: { status: 'planned' } });
    const empty = await planRow(emptyId);
    expect(await withWorkspaceContext(fx.ctx, (tx) => planGateService.raise(empty, tx))).toEqual({
      raised: false,
    });
    expect(await gatesOf(planId)).toEqual([]);
    expect(await gatesOf(emptyId)).toEqual([]);
  });

  it('`supersede` with nothing awaiting moves nothing', async () => {
    const { planId } = await draftPlan(['Nothing asked yet']);
    expect(
      await withWorkspaceContext(fx.ctx, (tx) =>
        planGateService.supersede(planId, 'plan_stale', tx),
      ),
    ).toBe(0);
  });
});

// ─── HELD, never superseded (§11.5c) ─────────────────────────────────────────

describe('HELD through a revision or a correction — the SAME gate, nothing superseded', () => {
  it('a revision append, an update_plan_proposal and a non-last withdrawal leave the same awaiting gate; an old stamp is refused', async () => {
    const { planId, itemIds } = await closedPlan(['One', 'Two', 'Three']);
    const [gate] = await gatesOf(planId);
    const before = await approvalGatesService.getForPlan({ planId }, fx.ctx);

    // A REVISION — the plan stays `planned`; the gate is held while the lease runs.
    await plansService.acquireRevisionLease(planId, fx.ctx, HARNESS);
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Added in the revision', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );
    expect(await gatesOf(planId)).toEqual([gate]);
    expect((await approvalGatesService.getForPlan({ planId }, fx.ctx)).gate?.held).toMatchObject({
      reason: 'revision_in_flight',
    });
    await plansService.releaseRevisionLease(planId, fx.ctx, HARNESS);

    // A CORRECTION outside a lease.
    await plansService.correctProposal(planId, itemIds[0]!, { title: 'Corrected' }, fx.ctx);
    expect(await gatesOf(planId)).toEqual([gate]);

    // A withdrawal SHORT of the last.
    await plansService.withdrawProposal(planId, itemIds[1]!, fx.ctx);
    expect(await gatesOf(planId)).toEqual([gate]);
    expect((await planRow(planId)).status).toBe('planned');

    // The stamp — not a fresh gate — is what refuses the reader of the old version.
    const err = await approvalGatesService
      .decide({ gateId: gate!.id, decision: 'approve', source: 'ui', stamp: before.stamp! }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalGateStaleSubjectError);
    expect(await gatesOf(planId)).toEqual([gate]);
  });
});

// ─── SUPERSEDED (§11.7 rows 4–5) ─────────────────────────────────────────────

describe('SUPERSEDED `plan_stale` when the plan goes stale — and a drift restore asks AGAIN', () => {
  it('drift supersedes the gate; `restoreForRevivedTarget` raises a FRESH one', async () => {
    const { planId, targetId } = await planTargeting();
    const [first] = await gatesOf(planId);

    await adminDb.workItem.update({ where: { id: targetId }, data: { status: 'done' } });
    const stale = await planDriftService.markStaleForTerminalTarget(targetId, fx.workspaceId, DONE);
    expect(stale.markedStale).toEqual([planId]);
    expect(await gatesOf(planId)).toEqual([
      expect.objectContaining({
        id: first!.id,
        state: 'superseded',
        supersededCause: 'plan_stale',
      }),
    ]);

    await adminDb.workItem.update({ where: { id: targetId }, data: { status: 'in_progress' } });
    const restored = await planDriftService.restoreForRevivedTarget(
      targetId,
      fx.workspaceId,
      REVIVE,
    );
    expect(restored.restored).toEqual([planId]);
    const gates = await gatesOf(planId);
    expect(gates.map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'plan_stale'],
      ['awaiting', null],
    ]);
    expect(gates[1]!.id).not.toBe(first!.id);
    expect(gates[1]!.routedToId).toBe(fx.ownerId);
  });

  it('`approvePlan`’s lazy backstop supersedes it too', async () => {
    const { planId, targetId } = await planTargeting();
    // The eager listener never ran: the target is finished but the plan still reads
    // `planned` — exactly the race the backstop exists for.
    await adminDb.workItem.update({ where: { id: targetId }, data: { status: 'done' } });
    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toMatchObject({
      code: 'PLAN_TARGET_IMMUTABLE',
    });
    expect((await planRow(planId)).status).toBe('stale');
    expect((await gatesOf(planId)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'plan_stale'],
    ]);
  });
});

describe('SUPERSEDED `plan_discarded` when the LAST proposal is withdrawn', () => {
  it('ends the plan and leaves no awaiting row', async () => {
    const { planId, itemIds } = await closedPlan(['Only one']);
    await plansService.withdrawProposal(planId, itemIds[0]!, fx.ctx);
    expect(await planRow(planId)).toMatchObject({
      status: 'declined',
      decisionReason: 'discarded',
    });
    expect((await gatesOf(planId)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'plan_discarded'],
    ]);
  });
});

describe('the ABANDONED-plan sweep leaves every gate untouched', () => {
  it('ends a dead `generating` plan and supersedes nothing', async () => {
    const { planId: askedId } = await closedPlan(['Asked']);
    const asked = await gatesOf(askedId);

    const dead = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'generating',
        sourceJobId: 'job_dead',
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const summary = await abandonedPlanService.reconcileAbandoned({
      deps: {
        resolveJobState: async () => ({ status: 'failed', reachable: true, failure: null }),
      },
    });
    expect(summary).toMatchObject({ declined: 1 });
    expect((await planRow(dead.id)).status).toBe('declined');
    expect(await gatesOf(dead.id)).toEqual([]);
    expect(await gatesOf(askedId)).toEqual(asked);
  });
});

// ─── DECIDED through the door (§11.7 row 6) ──────────────────────────────────

describe('DECIDED through the door — no awaiting gate left, none raised', () => {
  it.each(['approve', 'decline'] as const)('%s', async (decision) => {
    const { planId } = await closedPlan();
    const read = await approvalGatesService.getForPlan({ planId }, fx.ctx);
    await approvalGatesService.decide(
      { gateId: read.gate!.id, decision, source: 'ui', stamp: read.stamp! },
      fx.ctx,
    );
    const gates = await gatesOf(planId);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.state).toBe(decision === 'approve' ? 'approved' : 'declined');
    expect(await awaitingOf(planId)).toEqual([]);
  });
});

// ─── CONCURRENCY — real transactions against the real database ───────────────

describe('CONCURRENCY', () => {
  it('two raises in parallel leave exactly ONE awaiting row; the loser observes the winner’s gate', async () => {
    // A plan that was `planned` before the raise shipped (the backfill's shape).
    const { planId } = await draftPlan(['One', 'Two']);
    await adminDb.plan.update({
      where: { id: planId },
      data: { status: 'planned', plannedAt: new Date() },
    });
    const plan = await planRow(planId);

    const raiseHolding = () =>
      withWorkspaceContext(
        fx.ctx,
        async (tx) => {
          const out = await planGateService.raise(plan, tx);
          // Hold the plan lock past the other side's arrival.
          await new Promise((resolve) => setTimeout(resolve, 300));
          return out;
        },
        { timeoutMs: 20_000, maxWaitMs: 20_000 },
      );
    const [a, b] = await Promise.all([raiseHolding(), raiseHolding()]);

    const awaiting = await awaitingOf(planId);
    expect(awaiting).toHaveLength(1);
    expect([a.raised, b.raised].sort()).toEqual([false, true]);
    expect(a.gate?.id).toBe(awaiting[0]!.id);
    expect(b.gate?.id).toBe(awaiting[0]!.id);
  });

  it('a stale write racing the door: plan lock first on both sides — no deadlock, the supersede wins', async () => {
    const { planId } = await closedPlan();
    const read = await approvalGatesService.getForPlan({ planId }, fx.ctx);

    let planLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      planLocked = resolve;
    });
    // The drift writer's shape: lock the plan, write `stale`, withdraw the gate.
    const writer = withWorkspaceContext(
      fx.ctx,
      async (tx) => {
        await planRepository.lockById(planId, tx);
        planLocked();
        await new Promise((resolve) => setTimeout(resolve, 800));
        await planRepository.update(planId, { status: 'stale' }, tx);
        return planGateService.supersede(planId, 'plan_stale', tx);
      },
      { timeoutMs: 20_000, maxWaitMs: 20_000 },
    ).then(
      (n) => n,
      (e: unknown) => e,
    );
    await locked;
    const door = approvalGatesService
      .decide(
        { gateId: read.gate!.id, decision: 'decline', source: 'ui', stamp: read.stamp! },
        fx.ctx,
      )
      .then(
        (r) => r,
        (e: unknown) => e,
      );

    expect(await writer).toBe(1);
    const doorOutcome = await door;
    expect(doorOutcome).toBeInstanceOf(Error);
    expect(String(doorOutcome)).not.toMatch(/deadlock/i);
    expect((await planRow(planId)).status).toBe('stale');
    expect((await gatesOf(planId)).map((g) => [g.state, g.supersededCause])).toEqual([
      ['superseded', 'plan_stale'],
    ]);
  });
});
