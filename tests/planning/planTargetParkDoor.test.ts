import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanTargetLockedError } from '@/lib/planChange/errors';
import { PLANNING_STATUS_KEY, PLAN_TARGET_PLAN_LEASE_MS } from '@/lib/planChange/targetLock';
import { ABANDONED_PLAN_MAX_AGE_HOURS } from '@/lib/services/abandonedPlanService';
import { committedPlanTargets } from '@/lib/plans/planTargets';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Every case here drives a real plan append against a real Postgres, and the
// concurrency case does it three times over a fresh fixture each round. The
// 15s default is a unit-test budget; this is the same explicit one
// `planTargetLockService.test.ts` gives its own DB cases.
const DB_TEST_TIMEOUT_MS = 30_000;
const RACE_TEST_TIMEOUT_MS = 90_000;

// THE ONE PARK DOOR (MOTIR-5645), bug MOTIR-5640 — against a REAL Postgres,
// which is the only place a claim about a lock, a transaction or a race can be
// proved.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D1–D5: every plan parks
// every committed target it names, from any NON-terminal status, at the one
// choke point every authoring door passes through (`plansService.addProposals`).
//
// ⚠️ WHAT THIS FILE DOES NOT COVER, deliberately: RELEASE. Approve, decline and
// the empty close are MOTIR-5646's; the abandoned-plan expiry is MOTIR-5647's.
// A plan-held lock is released by nothing until those land, which is safe only
// because all three ship on one parent pull request.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A leaf at `status`, walked there through the legal edges. */
async function itemAt(status: string, title = `card at ${status}`): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  const walk: Record<string, string[]> = {
    todo: [],
    blocked: ['blocked'],
    in_progress: ['in_progress'],
    implemented: ['in_progress', 'implemented'],
    in_review: ['in_progress', 'in_review'],
    approved: ['in_progress', 'in_review', 'approved'],
    done: ['in_progress', 'done'],
  };
  for (const hop of walk[status] ?? []) {
    await workItemsService.updateStatus(item.id, hop, fx.ctx);
  }
  return item.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return row.status;
}

async function lockFor(workItemId: string) {
  return adminDb.planTargetLock.findUnique({ where: { workItemId } });
}

/** Open a plan and append one `modify` naming `workItemId`. */
async function planModifying(workItemId: string, title = 'a plan'): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId, patch: { priority: 'high' } }],
    fx.ctx,
  );
  return plan.id;
}

describe('committedPlanTargets — what a plan is ABOUT (D1)', () => {
  it('takes every modify/remove target and every COMMITTED add parentRef, and nothing else', () => {
    expect(
      committedPlanTargets([
        { op: 'modify', workItemId: 'wi_b' },
        { op: 'remove', workItemId: 'wi_a' },
        { op: 'add', parentRef: 'wi_c' },
        // Not targets, each for its own reason (see the module's header).
        { op: 'add', parentRef: 'planItem:abc' },
        { op: 'add', parentRef: 'folder:fold_1' },
        { op: 'add', parentRef: null },
      ]),
    ).toEqual(['wi_a', 'wi_b', 'wi_c']);
  });

  it('de-duplicates and sorts, so the caller inherits ONE fixed lock order', () => {
    expect(
      committedPlanTargets([
        { op: 'modify', workItemId: 'wi_z' },
        { op: 'add', parentRef: 'wi_a' },
        { op: 'remove', workItemId: 'wi_z' },
      ]),
    ).toEqual(['wi_a', 'wi_z']);
  });
});

describe('the plan lease window (D9)', () => {
  it('is ABANDONED_PLAN_MAX_AGE_HOURS, so the two cannot drift', () => {
    // `targetLock.ts` is a pure leaf and cannot import a service, so the number
    // is restated there and pinned HERE — the agreement is a test rather than an
    // import, which is what keeps the leaf a leaf.
    expect(PLAN_TARGET_PLAN_LEASE_MS).toBe(ABANDONED_PLAN_MAX_AGE_HOURS * 60 * 60 * 1000);
  });
});

describe('parking from every non-terminal status (D2)', () => {
  for (const from of ['todo', 'blocked', 'in_progress', 'implemented', 'in_review', 'approved']) {
    it(
      `an append with a modify on a card at \`${from}\` parks it and records priorStatus`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const id = await itemAt(from);
        expect(await statusOf(id)).toBe(from);

        // NO `transition_status` call anywhere — the append is the only thing that
        // runs, which is the whole point of the choke point.
        const planId = await planModifying(id);

        expect(await statusOf(id)).toBe(PLANNING_STATUS_KEY);
        const lock = await lockFor(id);
        expect(lock).toMatchObject({
          planId,
          sessionId: null,
          priorStatus: from,
          statusHeld: true,
        });
      },
    );
  }

  for (const terminal of ['done', 'cancelled']) {
    it(`a \`${terminal}\` target is NEVER parked — no lock row, no status move`, async () => {
      // ⚠️ THE APPEND DOES NOT REFUSE A TERMINAL TARGET, and MOTIR-5645's card
      // said it did — *"`done` / `cancelled` targets are already refused by
      // `validateProposals.ts`"*. That refusal is `validatePlanProposals`, which
      // needs `liveById` and so runs at the CLOSE. This test is what falsified
      // the premise: without the park's own terminal check it took a lock on
      // shipped work, which is exactly what AMENDMENT 16 D2 forbids.
      const item = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `${terminal} card` },
        fx.ctx,
      );
      await workItemsService.updateStatus(
        item.id,
        terminal === 'done' ? 'in_progress' : terminal,
        fx.ctx,
      );
      if (terminal === 'done') await workItemsService.updateStatus(item.id, 'done', fx.ctx);
      expect(await statusOf(item.id)).toBe(terminal);

      const plan = await plansService.createPlan(fx.projectId, { title: 'terminal' }, fx.ctx);
      // The append itself is accepted — the close is what refuses it.
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: item.id, patch: { priority: 'high' } }],
        fx.ctx,
      );

      expect(await statusOf(item.id)).toBe(terminal);
      expect(await lockFor(item.id)).toBeNull();
    });
  }

  it('parks the NON-terminal targets of a batch that also names a terminal one', async () => {
    const live = await itemAt('todo', 'the live one');
    const shipped = await itemAt('done', 'the shipped one');

    const plan = await plansService.createPlan(fx.projectId, { title: 'mixed' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: live, patch: { priority: 'high' } },
        { op: 'modify', workItemId: shipped, patch: { priority: 'high' } },
      ],
      fx.ctx,
    );

    expect(await lockFor(live)).toMatchObject({ planId: plan.id, priorStatus: 'todo' });
    expect(await lockFor(shipped)).toBeNull();
    expect(await statusOf(shipped)).toBe('done');
  });
});

describe('the other doors (D1)', () => {
  it('an `add` whose parentRef is a committed card parks THAT PARENT', async () => {
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'the container being laid into' },
      fx.ctx,
    );
    const plan = await plansService.createPlan(fx.projectId, { title: 'lay' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', parentRef: parent.id, proposedFields: { title: 'a new child', kind: 'task' } }],
      fx.ctx,
    );

    expect(await statusOf(parent.id)).toBe(PLANNING_STATUS_KEY);
    expect(await lockFor(parent.id)).toMatchObject({ planId: plan.id, priorStatus: 'todo' });
  });

  it('a `planItem:` parentRef parks nothing — a proposal has no row to park', async () => {
    const plan = await plansService.createPlan(fx.projectId, { title: 'two layers' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'the parent proposal', kind: 'story' } }],
      fx.ctx,
    );
    const parentProposalId = first.items[first.items.length - 1]!.id;

    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          parentRef: `planItem:${parentProposalId}`,
          proposedFields: { title: 'the child proposal', kind: 'task' },
        },
      ],
      fx.ctx,
    );

    expect(await adminDb.planTargetLock.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});

describe('one holder per card (D4)', () => {
  it('a SECOND plan naming a parked target is refused, and writes no proposal', async () => {
    const id = await itemAt('todo');
    const firstPlan = await planModifying(id, 'the holder');

    const second = await plansService.createPlan(fx.projectId, { title: 'the loser' }, fx.ctx);
    await expect(
      plansService.addProposals(
        second.id,
        [{ op: 'modify', workItemId: id, patch: { priority: 'low' } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanTargetLockedError);

    // The refusal left the losing plan byte-identical…
    expect(await adminDb.planItem.count({ where: { planId: second.id } })).toBe(0);
    // …and the winner still holds it.
    expect(await lockFor(id)).toMatchObject({ planId: firstPlan });
    expect(await statusOf(id)).toBe(PLANNING_STATUS_KEY);
  });

  it('the SAME plan re-appending to a target it holds is a no-op, not a second lock', async () => {
    const id = await itemAt('in_progress');
    const planId = await planModifying(id);
    const before = await lockFor(id);

    await plansService.addProposals(
      planId,
      [{ op: 'add', parentRef: id, proposedFields: { title: 'a child', kind: 'task' } }],
      fx.ctx,
    );

    expect(await adminDb.planTargetLock.count({ where: { workItemId: id } })).toBe(1);
    const after = await lockFor(id);
    // `priorStatus` is INHERITED on a refresh, never recomputed — recomputing
    // would read `planning` and the eventual release would strand the card.
    expect(after!.priorStatus).toBe('in_progress');
    expect(after!.id).toBe(before!.id);
  });

  it('a HAND-PARKED card is ADOPTED — statusHeld false, no prior status to restore', async () => {
    const id = await itemAt('todo');
    await workItemsService.updateStatus(id, PLANNING_STATUS_KEY, fx.ctx);

    const planId = await planModifying(id, 'adopting a hand-parked card');

    expect(await lockFor(id)).toMatchObject({
      planId,
      priorStatus: PLANNING_STATUS_KEY,
      // Nothing recorded where it came from, so there is nothing to restore —
      // every release RESTS it instead (MOTIR-6066, planTargetAdoptedRelease.test.ts).
      statusHeld: false,
    });
  });
});

describe('claimability while parked (D2, and the claim doors)', () => {
  it('a card parked from `blocked` leaves the to-do category, so neither claim door takes it', async () => {
    const id = await itemAt('blocked');
    // `blocked` is in the TO-DO category, so before the park both doors would
    // hand this card out. That is exactly why `planning` is an in-progress
    // status rather than another to-do one.
    await planModifying(id);

    // A refusal is a RESULT here, not an error — the claim door reports WHICH.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
    const claim = await workItemsService.claimWorkItem(fx.projectId, row.identifier, fx.ctx);
    expect(claim.outcome).toBe('not_claimable');
    expect(claim.claimed).toBe(false);

    const candidate = await adminDb.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n
         FROM "work_item" w
         JOIN "workflow_status" ws
           ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."id" = $1 AND ws."category" = 'todo'`,
      id,
    );
    expect(candidate[0]!.n).toBe(0);
  });
});

describe('real concurrency (D4)', () => {
  it(
    'two plans racing for ONE target: exactly one lock and one refusal',
    { timeout: RACE_TEST_TIMEOUT_MS },
    async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const id = await itemAt('todo');

        const a = await plansService.createPlan(fx.projectId, { title: 'racer A' }, fx.ctx);
        const b = await plansService.createPlan(fx.projectId, { title: 'racer B' }, fx.ctx);

        const results = await Promise.allSettled([
          plansService.addProposals(
            a.id,
            [{ op: 'modify', workItemId: id, patch: { priority: 'high' } }],
            fx.ctx,
          ),
          plansService.addProposals(
            b.id,
            [{ op: 'modify', workItemId: id, patch: { priority: 'low' } }],
            fx.ctx,
          ),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        // The loser gets the TYPED refusal — never a raw P2002, and never a 500.
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PlanTargetLockedError);

        expect(await adminDb.planTargetLock.count({ where: { workItemId: id } })).toBe(1);
        expect(await statusOf(id)).toBe(PLANNING_STATUS_KEY);
      }
    },
  );
});

describe('the lock row itself', () => {
  it('names EXACTLY ONE holder — the database CHECK refuses anything else', async () => {
    const id = await itemAt('todo');
    const planId = await planModifying(id);
    const lock = await lockFor(id);

    // Both holders at once is the shape the CHECK exists to refuse.
    await expect(
      adminDb.$executeRawUnsafe(
        `UPDATE "plan_target_lock" SET "session_id" = $1 WHERE "id" = $2`,
        'some-session-id',
        lock!.id,
      ),
    ).rejects.toThrow();

    // And neither holder is refused too.
    await expect(
      adminDb.$executeRawUnsafe(
        `UPDATE "plan_target_lock" SET "plan_id" = NULL WHERE "id" = $1`,
        lock!.id,
      ),
    ).rejects.toThrow();

    expect(await lockFor(id)).toMatchObject({ planId, sessionId: null });
  });

  it('is CASCADE-deleted with its plan, so a deleted plan holds nothing', async () => {
    const id = await itemAt('todo');
    const planId = await planModifying(id);

    await adminDb.plan.delete({ where: { id: planId } });

    expect(await lockFor(id)).toBeNull();
    // The STATUS is not restored by the cascade — that is the release path's
    // job, and the FK only exists so no row points at a plan that is gone.
    expect(await statusOf(id)).toBe(PLANNING_STATUS_KEY);
  });
});

describe('the park is INSIDE the append transaction', () => {
  it('a refused append leaves the card untouched — no park without proposals', async () => {
    const id = await itemAt('todo');
    const plan = await plansService.createPlan(fx.projectId, { title: 'will fail' }, fx.ctx);

    // A `planItem:` ref naming nothing is refused by `assertTempRefsResolvable`,
    // which runs BEFORE the park. Nothing should be held afterwards.
    await expect(
      plansService.addProposals(
        plan.id,
        [
          { op: 'modify', workItemId: id, patch: { priority: 'high' } },
          {
            op: 'add',
            parentRef: 'planItem:does-not-exist',
            proposedFields: { title: 'orphan', kind: 'task' },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toThrow();

    expect(await statusOf(id)).toBe('todo');
    expect(await lockFor(id)).toBeNull();
    expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  });
});
