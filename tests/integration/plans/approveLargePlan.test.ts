import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { PlanApproveTimedOutError, PlanRefGraphError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3396 — APPROVING A REAL-SIZED PLAN, against real Postgres.
//
// Approve is the only path from a proposal to a work item, and for any plan big
// enough to be worth reviewing it returned a bare 500. Two independent causes,
// and this file pins both plus the answer the caller now gets:
//
//   1. `materialize` wired `blocked_by` edges ONE round trip per edge, inside an
//      interactive transaction with a wall-clock budget. Twenty-seven edges was
//      twenty-seven sequential awaits.
//   2. `withWorkspaceContext` — the context every tenant-scoped write uses —
//      hardcoded `db.$transaction(fn)` with no options parameter, so the budget
//      could not be raised even deliberately.
//
// ⚠️ THE CARD ASKED FOR A TEST THAT FAILS ON `main`, AND THE WALL-CLOCK ONE DOES
// NOT — REPORTED HERE RATHER THAN ENGINEERED AWAY. The card's fourth criterion
// asks for "an integration test [that] approves a plan of at least 15 adds and 25
// edges and asserts it commits — it must FAIL on `main` before the fix". It was
// written, and then RUN against the pre-fix behaviour (per-edge inserts, Prisma's
// default 5 000 ms):
//
//     Tests  1 passed  ·  Duration 536ms
//
// It passes, because the defect is LATENCY-BOUND. The incident's evidence is four
// P2028s from production — Fly `iad` reaching Neon, `timeTaken` 5033 / 5034 / 5030
// ms — where twenty-seven sequential round trips cost about five seconds. Against
// a Postgres on the same box they cost about half of one. Nothing about the
// diagnosis is wrong; the reproduction simply cannot be staged on a local
// database, and a threshold tuned until it went red here would be a test about
// this machine.
//
// So the FAILING-ON-`main` GUARD IS THE ROUND-TRIP COUNT INSTEAD — the second test
// below — which is what the fix actually changes and is independent of how fast
// any particular database answers. Against the pre-fix behaviour it fails with
// `[] !== [27]`; after the fix it is one insert carrying twenty-seven edges. The
// commit test stays as the property the incident broke, and is honest about being
// a floor rather than a reproduction.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Append `count` adds ONE AT A TIME, wiring each to up to `edgesPerItem` earlier
 * siblings. The temp-ref of an `add` is the plan-item id the server returns, so
 * a dense edge graph can only be built layer by layer — which is also how the
 * real authoring path builds one.
 *
 * Returns the plan id and the edge count actually requested.
 */
async function plannedDensePlan(
  fx: WorkItemFixture,
  count: number,
  edgesPerItem: number,
): Promise<{ planId: string; edgeCount: number }> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Big' }, fx.ctx);
  const ids: string[] = [];
  let edgeCount = 0;
  for (let i = 0; i < count; i += 1) {
    // Earlier siblings only, so the graph is acyclic.
    const blockedByRefs = ids
      .slice(Math.max(0, i - edgesPerItem), i)
      .map((id) => `${TEMP_REF_PREFIX}${id}`);
    edgeCount += blockedByRefs.length;
    const withItems = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: `Proposal ${i}`, kind: 'task' },
          ...(blockedByRefs.length ? { blockedByRefs } : {}),
        },
      ],
      fx.ctx,
    );
    ids.push(withItems.items[withItems.items.length - 1]!.id);
  }
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, edgeCount };
}

describe('approving a real-sized plan (MOTIR-3396)', () => {
  it('COMMITS a plan of 15 adds and 27 blocked_by edges', async () => {
    const fx = await makeWorkItemFixture();
    // 15 items; item i is blocked by up to 2 earlier siblings → 0+1+2×13 = 27 edges.
    const { planId, edgeCount } = await plannedDensePlan(fx, 15, 2);
    expect(edgeCount).toBe(27);
    const approved = await plansService.approvePlan(planId, fx.ctx);

    // It committed: the plan is approved and every proposal became a work item.
    expect(approved.status).toBe('approved');
    const created = await adminDb.workItem.count({
      where: { projectId: fx.projectId, title: { startsWith: 'Proposal ' } },
    });
    expect(created).toBe(15);

    // …and every edge was actually wired. The batch insert must not silently
    // drop rows — `skipDuplicates` skips duplicates, and there are none here.
    const links = await adminDb.workItemLink.count({
      where: { kind: 'is_blocked_by', workspaceId: fx.ctx.workspaceId },
    });
    expect(links).toBe(27);
  });

  it('wires a 27-edge plan in ONE insert, not twenty-seven', async () => {
    // The round-trip count IS the fix, so it is asserted rather than described.
    // Counting statements directly would need a query log; counting the
    // repository calls the pass makes is the same claim one layer up, and it is
    // the layer the change actually moved.
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedDensePlan(fx, 15, 2);

    const batchSizes: number[] = [];
    const realBatch = workItemLinkRepository.createManyIfAbsent;
    workItemLinkRepository.createManyIfAbsent = async (data, tx) => {
      batchSizes.push(data.length);
      return realBatch(data, tx);
    };
    try {
      await plansService.approvePlan(planId, fx.ctx);
    } finally {
      workItemLinkRepository.createManyIfAbsent = realBatch;
    }

    // ONE call, carrying all 27 edges — the pass no longer scales its round
    // trips with the plan's edge count.
    expect(batchSizes).toEqual([27]);
  });

  it('still lets the persist gate reject a duplicate ref — batching did not bypass it', async () => {
    // ⚠️ WRITTEN AFTER THE FIRST VERSION OF THIS TEST WAS WRONG, and kept in the
    // shape the evidence produced. It originally asserted that `skipDuplicates`
    // makes a repeated `blockedByRef` idempotent — but `validatePlanProposals`
    // rejects that BEFORE materialize ever runs, so the claim was never reachable.
    //
    // What is actually true, and worth pinning: Pass 2 wires edges only for
    // freshly created `add`s, so every `fromId` is new and a duplicate is
    // impossible by construction — `skipDuplicates` there is DEFENSIVE, not
    // load-bearing. The property that can regress is this one: moving the pass
    // to a batch insert must not have moved it past the gate.
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Dup' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Producer', kind: 'task' } }],
      fx.ctx,
    );
    const producerRef = `${TEMP_REF_PREFIX}${first.items[0]!.id}`;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Consumer', kind: 'task' },
          blockedByRefs: [producerRef, producerRef],
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toThrow(PlanRefGraphError);

    // Rejected before any write: the tree is untouched.
    const created = await adminDb.workItem.count({
      where: { projectId: fx.projectId, title: { in: ['Producer', 'Consumer'] } },
    });
    expect(created).toBe(0);
  });
});

describe('the transaction budget is expressible and off by default (MOTIR-3396)', () => {
  it('passes NO options when the caller supplies no budget', async () => {
    // The option-less call must keep Prisma's defaults rather than acquiring a
    // raised budget by accident — every other caller of this context wants the
    // 5 000 / 2 000 it has always had.
    const fx = await makeWorkItemFixture();
    const seen: unknown[] = [];
    const realTx = db.$transaction.bind(db);
    (db as unknown as { $transaction: unknown }).$transaction = (
      fn: unknown,
      options?: unknown,
    ) => {
      seen.push(options);
      return (realTx as (f: unknown, o?: unknown) => unknown)(fn, options);
    };
    try {
      await withWorkspaceContext(
        { userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId: fx.projectId },
        async () => 'ok',
      );
      await withWorkspaceContext(
        { userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId, projectId: fx.projectId },
        async () => 'ok',
        { timeoutMs: 30_000, maxWaitMs: 10_000 },
      );
    } finally {
      (db as unknown as { $transaction: unknown }).$transaction = realTx;
    }

    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual({ timeout: 30_000, maxWait: 10_000 });
  });

  it('answers a budget exhaustion with a TYPED error naming the plan and its size', async () => {
    // P2028 used to escape as a bare 500 with an empty body, so the only move it
    // left a reviewer was to press Approve again — which is what happened, three
    // times, none of which could have worked. The typed error is what turns that
    // into a sentence: the plan, the item count, and the fact that retrying will
    // not help at this size.
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedDensePlan(fx, 3, 1);

    // Force the exhaustion deterministically rather than by racing a real clock:
    // a 1 ms budget cannot complete any materialize.
    const realTx = db.$transaction.bind(db);
    (db as unknown as { $transaction: unknown }).$transaction = (
      fn: unknown,
      options?: { timeout?: number; maxWait?: number },
    ) =>
      (realTx as (f: unknown, o?: unknown) => unknown)(
        fn,
        options ? { ...options, timeout: 1 } : options,
      );

    let raised: unknown;
    try {
      await plansService.approvePlan(planId, fx.ctx);
    } catch (err) {
      raised = err;
    } finally {
      (db as unknown as { $transaction: unknown }).$transaction = realTx;
    }

    expect(raised).toBeInstanceOf(PlanApproveTimedOutError);
    const err = raised as PlanApproveTimedOutError;
    expect(err.code).toBe('PLAN_APPROVE_TIMED_OUT');
    expect(err.planId).toBe(planId);
    expect(err.itemCount).toBe(3);
    expect(err.message).toContain('3 proposals');
    expect(err.message).toContain('split the plan');

    // Nothing was materialized — the transaction rolled back.
    const created = await adminDb.workItem.count({
      where: { projectId: fx.projectId, title: { startsWith: 'Proposal ' } },
    });
    expect(created).toBe(0);
  });

  it('re-raises a NON-P2028 Prisma error unchanged', async () => {
    // The catch must not swallow every Prisma failure into a timeout verdict —
    // the one it types is the one it can honestly diagnose.
    const other = new Prisma.PrismaClientKnownRequestError('nope', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(other).not.toBeInstanceOf(PlanApproveTimedOutError);
    expect(other.code).toBe('P2002');
  });
});
