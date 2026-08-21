import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PlanApproveTimedOutError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3396 — approving a plan big enough to be worth reviewing returned a bare
// 500. Two independent contributors, and this file covers both plus the response
// that made the failure legible:
//
//   1. `materialize`'s `blocked_by` pass was one network round trip PER EDGE, so
//      a 15-item / 27-edge plan spent 27 sequential Fly→Neon waits at the END of
//      an interactive transaction that had already created 15 work items.
//   2. `approvePlan` opened that transaction through `withWorkspaceContext`,
//      which — alone among the four contexts in `lib/workspaces/context.ts` —
//      could not be given a `TransactionBudget` at all, so it ran on Prisma's
//      default 5 000 ms / 2 000 ms.
//
// ⚠️ WHAT THIS FILE CAN AND CANNOT PROVE, SAID PLAINLY. The production failure
// is P2028 on WALL CLOCK, and its cause is per-round-trip LATENCY (Fly `iad` →
// Neon, ~180 ms × 27). A local Postgres over a unix socket answers each of those
// in well under a millisecond, so the timeout does not reproduce here and a test
// asserting elapsed time would assert the network, flakily.
//
// So what is asserted is the PROPERTY that removes the latency — the edge pass
// costs ONE round trip rather than N — which is deterministic, and which fails
// on `main` for exactly the right reason: `main` calls the single-row
// `workItemLinkRepository.create` 27 times, and the first case below asserts it
// is called zero times for `is_blocked_by`.

async function seedItem(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

const ADD_COUNT = 15;

/**
 * The failing plan's shape, reproduced: 15 `add` proposals wired into a DAG of
 * 27 `blocked_by` edges — 26 intra-plan (`planItem:` temp-refs) plus one onto a
 * real, pre-existing work item, so the batch is exercised on BOTH ref kinds.
 *
 * The 27 are, per card `i`:
 *   • card 0            → the REAL blocker                    (1 edge)
 *   • cards 1…14        → card `i - 1`   (the chain)          (14 edges)
 *   • cards 3…14        → card `i - 3`   (the skip edges)     (12 edges)
 *
 * Acyclic by construction — every edge points at a LOWER index — which matters
 * because the DB's cycle trigger fires per row and would reject the batch.
 * Returns the plan id, `planned`.
 */
async function bigPlannedPlan(fx: WorkItemFixture, realBlockerId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Big tree' }, fx.ctx);

  // Appended one layer at a time so each returned id can be used as a temp-ref
  // by the next — the same discipline an authoring agent follows.
  const ids: string[] = [];
  for (let i = 0; i < ADD_COUNT; i += 1) {
    const blockedByRefs: string[] = [];
    if (i === 0) blockedByRefs.push(realBlockerId);
    if (i >= 1) blockedByRefs.push(`planItem:${ids[i - 1]}`);
    if (i >= 3) blockedByRefs.push(`planItem:${ids[i - 3]}`);
    const after = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: `Card ${i}`, kind: 'task', type: 'code' },
          blockedByRefs,
        },
      ],
      fx.ctx,
    );
    ids.push(after.items[after.items.length - 1]!.id);
  }
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

/** 1 real + 14 chain + 12 skip. Asserted, not assumed — a helper that quietly
 *  stopped wiring edges would otherwise make the round-trip claim vacuous. */
const EXPECTED_EDGES = 27;

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

describe('approvePlan — a 15-add / 27-edge plan materializes in one transaction (MOTIR-3396)', () => {
  it('commits: every add exists, every blocked_by edge is wired, and the edge pass makes ZERO per-edge round trips', async () => {
    const fx = await makeWorkItemFixture();
    const realBlockerId = await seedItem(fx, 'Existing blocker');
    const planId = await bigPlannedPlan(fx, realBlockerId);

    // The per-edge write path. On `main` materialize calls this once per edge;
    // after the fix the whole graph goes out through the batch form, so this is
    // untouched for `is_blocked_by`. THIS is the assertion that fails on `main`.
    const perRowCreate = vi.spyOn(workItemLinkRepository, 'create');

    const approved = await plansService.approvePlan(planId, fx.ctx);
    expect(approved.status).toBe('approved');

    // Asserted as a NUMBER, deliberately: the recorded call args carry the
    // Prisma `TransactionClient`, and letting vitest render those in a failure
    // diff overflows the stack — which on `main` replaces the one number that
    // explains the failure ("expected 27 to be 0") with a RangeError.
    const perEdgeRoundTrips = perRowCreate.mock.calls.filter(
      ([data]) => data.kind === 'is_blocked_by',
    ).length;
    expect(perEdgeRoundTrips).toBe(0);

    // …and it genuinely committed the whole tree, which is the criterion's own
    // words. 15 new items on top of the seeded blocker.
    const created = await adminDb.workItem.findMany({ where: { title: { startsWith: 'Card ' } } });
    expect(created).toHaveLength(ADD_COUNT);

    const edges = await adminDb.workItemLink.findMany({ where: { kind: 'is_blocked_by' } });
    expect(edges).toHaveLength(EXPECTED_EDGES);

    // The one REAL (non-temp) ref resolved to the pre-existing item, so the
    // batch did not quietly drop the ref kind that has no `planItem:` prefix.
    const card0 = created.find((c) => c.title === 'Card 0')!;
    expect(edges.some((e) => e.fromId === card0.id && e.toId === realBlockerId)).toBe(true);
  });

  it('sends the whole edge graph as ONE batch call', async () => {
    const fx = await makeWorkItemFixture();
    const realBlockerId = await seedItem(fx, 'Existing blocker');
    const planId = await bigPlannedPlan(fx, realBlockerId);

    const batch = vi.spyOn(workItemLinkRepository, 'createManyIfAbsent');
    await plansService.approvePlan(planId, fx.ctx);

    // ONE call carrying every edge — the round-trip count for the edge pass goes
    // 27 → 1. (`createIfAbsent` now delegates here, so Pass 3's auto-relate
    // would also land on this spy — but only for a body that MENTIONS another
    // item, and these bodies carry no mentions. The edge pass is the only
    // caller, which is why the count is exact rather than a lower bound.)
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(EXPECTED_EDGES);
  });
});

describe('withWorkspaceContext — the transaction budget is opt-IN (MOTIR-3396)', () => {
  it('passes NO options to $transaction when called without a budget, so Prisma keeps its defaults', async () => {
    const fx = await makeWorkItemFixture();
    const tx = vi.spyOn(db, '$transaction');

    await withWorkspaceContext(fx.ctx, async () => 'ok');

    expect(tx).toHaveBeenCalledTimes(1);
    // The second argument is what carries `timeout` / `maxWait`. `undefined` is
    // the whole contract of the option-less call: adding the parameter must not
    // change one existing caller's budget.
    expect(tx.mock.calls[0]![1]).toBeUndefined();
  });

  it('applies an explicit budget exactly as withWorkspaceServiceContext does', async () => {
    const fx = await makeWorkItemFixture();
    const tx = vi.spyOn(db, '$transaction');

    await withWorkspaceContext(fx.ctx, async () => 'ok', { timeoutMs: 30_000, maxWaitMs: 10_000 });

    expect(tx.mock.calls[0]![1]).toEqual({ timeout: 30_000, maxWait: 10_000 });
  });

  it('approvePlan opens its transaction WITH a raised budget', async () => {
    const fx = await makeWorkItemFixture();
    const realBlockerId = await seedItem(fx, 'Existing blocker');
    const planId = await bigPlannedPlan(fx, realBlockerId);

    const tx = vi.spyOn(db, '$transaction');
    await plansService.approvePlan(planId, fx.ctx);

    // approve makes several transactions (the pre-transaction reads use
    // `withWorkspaceServiceContext`); the materialize one is the only one that
    // carries a budget, and it is the raised one.
    const budgeted = tx.mock.calls.map((c) => c[1]).filter((o) => o !== undefined);
    expect(budgeted).toContainEqual({ timeout: 30_000, maxWait: 10_000 });
  });
});

describe('PlanApproveTimedOutError — a timeout is a sentence, not a bare 500 (MOTIR-3396)', () => {
  it('names the plan and its item count, and says nothing was written', () => {
    const err = new PlanApproveTimedOutError('plan_abc', 15);
    expect(err.code).toBe('PLAN_APPROVE_TIMED_OUT');
    expect(err.planId).toBe('plan_abc');
    expect(err.itemCount).toBe(15);
    expect(err.message).toContain('plan_abc');
    expect(err.message).toContain('15 proposals');
    expect(err.message).toContain('Nothing was created');
  });

  it('singularises a one-proposal plan', () => {
    expect(new PlanApproveTimedOutError('p', 1).message).toContain('(1 proposal)');
  });
});
