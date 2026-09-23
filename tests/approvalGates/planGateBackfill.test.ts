import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { planGateBackfillService } from '@/lib/services/planGateBackfillService';
import { planGateService } from '@/lib/services/planGateService';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { parseArgs, run } from '../../scripts/backfill-plan-approval-gates';

// THE PLAN-GATE BACKFILL (Story MOTIR-6012 · Subtask MOTIR-6039; ADR
// `approval-gates.md` §11.9) — `pnpm db:backfill:plan-gates`, against a REAL Postgres.
//
// The fixture writes a plan's `planned` status DIRECTLY where the case is a plan that
// was `planned` BEFORE the raise shipped: that is the backfill's whole population, and
// the code that produced it (a close that raised nothing) no longer exists. Every gate
// the assertions read was written by the product — by `markPlanned`, or by the sweep.

let fx: WorkItemFixture;
let other: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  other = await makeWorkItemFixture({ name: 'Beta', identifier: 'BETA' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const awaitingOf = (planId: string) =>
  adminDb.approvalGate.findMany({
    where: { kind: 'plan_approval', subjectId: planId, state: 'awaiting' },
  });
const gateCount = () => adminDb.approvalGate.count({ where: { kind: 'plan_approval' } });

type PlanStatus = 'generating' | 'planned' | 'stale' | 'approved' | 'declined';

/** A plan in `f`'s project holding `proposals` adds, forced to `status` WITHOUT a raise. */
async function seedPlan(
  f: WorkItemFixture,
  opts: {
    status?: PlanStatus;
    proposals?: number;
    createdById?: string;
    origin?: 'user' | 'cadence';
  } = {},
) {
  const plan = await plansService.createPlan(
    f.projectId,
    {
      title: 'A plan',
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      ...(opts.createdById ? { createdById: opts.createdById } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
    f.ctx,
  );
  for (let i = 0; i < (opts.proposals ?? 1); i += 1) {
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: `Item ${i}`, kind: 'task' } }],
      f.ctx,
    );
  }
  const status = opts.status ?? 'planned';
  if (status !== 'generating') {
    await adminDb.plan.update({ where: { id: plan.id }, data: { status } });
  }
  return plan.id;
}

/** The card's fixture, in `fx`'s workspace, plus one ungated plan in `other`'s. */
async function seedPopulation() {
  const asker = await createTestUser({ email: 'asker@ex.com', name: 'Asker' });
  const gone = await createTestUser({ email: 'gone@ex.com', name: 'Gone' });

  const ungated = await seedPlan(fx, { createdById: asker.id, proposals: 2 });
  // Already asked: closed through the product, which raised its gate.
  const asked = await plansService.createPlan(fx.projectId, { title: 'Asked' }, fx.ctx);
  await plansService.addProposals(
    asked.id,
    [{ op: 'add', proposedFields: { title: 'x', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(asked.id, fx.ctx);
  const empty = await seedPlan(fx, { proposals: 0 });
  const stale = await seedPlan(fx, { status: 'stale' });
  const approved = await seedPlan(fx, { status: 'approved' });
  const declined = await seedPlan(fx, { status: 'declined' });
  const generating = await seedPlan(fx, { status: 'generating' });
  const cadence = await seedPlan(fx, { origin: 'cadence' });
  const orphaned = await seedPlan(fx, { createdById: gone.id });
  // The author no longer exists: `createdById` is ON DELETE SET NULL.
  await adminDb.user.delete({ where: { id: gone.id } });
  const elsewhere = await seedPlan(other);

  return {
    asker,
    ungated,
    asked: asked.id,
    empty,
    stale,
    approved,
    declined,
    generating,
    cadence,
    orphaned,
    elsewhere,
  };
}

describe('the population — `planned`, ≥1 proposal, no awaiting gate', () => {
  it('raises exactly one gate per such plan, routed as a live raise routes it, and touches nothing else', async () => {
    const p = await seedPopulation();
    const [askedGate] = await awaitingOf(p.asked);

    const report = await planGateBackfillService.backfill({ dryRun: false });

    expect(report.raised.map((r) => r.planId).sort()).toEqual(
      [p.ungated, p.cadence, p.orphaned, p.elsewhere].sort(),
    );
    expect(report).toMatchObject({
      total: 6, // every `planned` plan, across both workspaces
      examined: 6,
      alreadyAwaiting: 1,
      noProposals: 1,
      notPlanned: 0,
      failed: [],
      interrupted: false,
    });

    // Routing (§11.6): the requester, else the workspace owner — the cadence plan's
    // null requester and the deleted author's nulled one both reach the owner.
    const routeOf = async (planId: string) => (await awaitingOf(planId))[0]?.routedToId;
    expect(await routeOf(p.ungated)).toBe(p.asker.id);
    expect(await routeOf(p.cadence)).toBe(fx.ownerId);
    expect(await routeOf(p.orphaned)).toBe(fx.ownerId);
    expect(await routeOf(p.elsewhere)).toBe(other.ownerId);
    for (const id of [p.ungated, p.cadence, p.orphaned, p.elsewhere]) {
      const gates = await awaitingOf(id);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({ workItemId: null, subjectId: id });
      expect(gates[0]!.subjectVersion).toMatch(/^plan\.v1\.[0-9a-f]{64}$/);
    }

    // Untouched: the already-asked plan keeps its ONE original gate; the rest have none.
    expect(await awaitingOf(p.asked)).toEqual([askedGate]);
    for (const id of [p.empty, p.stale, p.approved, p.declined, p.generating]) {
      expect(await adminDb.approvalGate.count({ where: { subjectId: id } })).toBe(0);
    }
    // …and no plan changed status.
    const statuses = await adminDb.plan.findMany({ select: { id: true, status: true } });
    expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toMatchObject({
      [p.stale]: 'stale',
      [p.approved]: 'approved',
      [p.declined]: 'declined',
      [p.generating]: 'generating',
      [p.empty]: 'planned',
    });

    // Per-workspace counts.
    const byWs = Object.fromEntries(report.byWorkspace.map((w) => [w.workspaceId, w]));
    expect(byWs[fx.workspaceId]).toMatchObject({
      examined: 5,
      raise: 3,
      alreadyAwaiting: 1,
      noProposals: 1,
      failed: 0,
    });
    expect(byWs[other.workspaceId]).toMatchObject({ examined: 1, raise: 1 });
  });

  it('a SECOND run raises zero and writes nothing', async () => {
    await seedPopulation();
    await planGateBackfillService.backfill({ dryRun: false });
    const before = await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } });

    const again = await planGateBackfillService.backfill({ dryRun: false });

    expect(again.raised).toEqual([]);
    expect(again).toMatchObject({ alreadyAwaiting: 5, noProposals: 1, failed: [] });
    expect(await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});

describe('the MIGRATION raises what the shipped raise would (MOTIR-6039, §11.9 amended)', () => {
  // The deploy runs `20260923200200_backfill_plan_approval_gates`: plain SQL carrying a
  // second, frozen copy of the population and routing rules. This proves the two copies
  // agree — the script's dry-run (which goes through `planGateService`) predicts EXACTLY
  // the rows the migration inserts, and afterwards predicts nothing.
  const migrationSql = readFileSync(
    path.join(
      process.cwd(),
      'prisma/migrations/20260923200200_backfill_plan_approval_gates/migration.sql',
    ),
    'utf8',
  );

  it('inserts one card-less awaiting gate per plan the dry-run predicts, routed the same', async () => {
    const p = await seedPopulation();
    const [askedGate] = await awaitingOf(p.asked);
    const dry = await planGateBackfillService.backfill({ dryRun: true });

    await adminDb.$executeRawUnsafe(migrationSql);

    const inserted = await adminDb.approvalGate.findMany({
      where: { kind: 'plan_approval', state: 'awaiting', NOT: { id: askedGate!.id } },
    });
    const key = (r: { planId: string; routedToId: string | null }) => `${r.planId}:${r.routedToId}`;
    expect(
      inserted.map((g) => key({ planId: g.subjectId, routedToId: g.routedToId })).sort(),
    ).toEqual(dry.raised.map(key).sort());
    expect(inserted.map((g) => g.subjectId).sort()).toEqual(
      [p.ungated, p.cadence, p.orphaned, p.elsewhere].sort(),
    );
    for (const g of inserted) {
      expect(g).toMatchObject({ workItemId: null, subjectVersion: null, decidedById: null });
    }
    // The already-asked plan keeps its one gate; nothing else gained one.
    expect(await awaitingOf(p.asked)).toEqual([askedGate]);
    for (const id of [p.empty, p.stale, p.approved, p.declined, p.generating]) {
      expect(await adminDb.approvalGate.count({ where: { subjectId: id } })).toBe(0);
    }

    // After the deploy, the verification tool finds nothing left to raise.
    expect((await planGateBackfillService.backfill({ dryRun: true })).raised).toEqual([]);
  });

  it('is idempotent — applying its SQL a second time inserts nothing', async () => {
    await seedPopulation();
    await adminDb.$executeRawUnsafe(migrationSql);
    const before = await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } });
    await adminDb.$executeRawUnsafe(migrationSql);
    expect(await adminDb.approvalGate.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('a migration-raised gate (no raise-time digest) is decided through the door like any other', async () => {
    const p = await seedPopulation();
    await adminDb.$executeRawUnsafe(migrationSql);
    const read = await approvalGatesService.getForPlan({ planId: p.ungated }, fx.ctx);
    expect(read.gate?.state).toBe('awaiting');
    const decided = await approvalGatesService.decide(
      { gateId: read.gate!.id, decision: 'decline', stamp: read.stamp!, source: 'api' },
      fx.ctx,
    );
    expect(decided.gate.state).toBe('declined');
    expect(decided.gate.subjectVersion).toMatch(/^plan\.v1\.[0-9a-f]{64}$/);
  });
});

describe('`--dry-run` predicts the real run exactly', () => {
  it('counts the same plans, routes them the same, and writes nothing', async () => {
    await seedPopulation();
    const gatesBefore = await gateCount();

    const dry = await planGateBackfillService.backfill({ dryRun: true });
    expect(await gateCount()).toBe(gatesBefore);

    const real = await planGateBackfillService.backfill({ dryRun: false });
    const key = (r: { planId: string; routedToId: string | null }) => `${r.planId}:${r.routedToId}`;
    expect(dry.raised.map(key).sort()).toEqual(real.raised.map(key).sort());
    expect(dry.raised).toHaveLength(4);
    expect(dry.byWorkspace).toEqual(real.byWorkspace);
    expect(await gateCount()).toBe(gatesBefore + 4);

    // And after the real run the prediction is zero.
    expect((await planGateBackfillService.backfill({ dryRun: true })).raised).toEqual([]);
  });
});

describe('--workspace narrows; the default is cross-tenant', () => {
  it('only the named tenant is examined and raised', async () => {
    const p = await seedPopulation();
    const report = await planGateBackfillService.backfill({
      dryRun: false,
      workspaceId: other.workspaceId,
    });
    expect(report.raised.map((r) => r.planId)).toEqual([p.elsewhere]);
    expect(report.total).toBe(1);
    expect(await awaitingOf(p.ungated)).toEqual([]);
  });
});

describe('one transaction per plan', () => {
  it('a failing plan rolls back ALONE — its raise is undone, the others are kept', async () => {
    const p = await seedPopulation();
    const realRaise = planGateService.raise.bind(planGateService);
    vi.spyOn(planGateService, 'raise').mockImplementation(async (plan, tx) => {
      const result = await realRaise(plan, tx);
      // Fail AFTER the insert, so the assertion below proves the rollback.
      if (plan.id === p.cadence) throw new Error('boom');
      return result;
    });

    const report = await planGateBackfillService.backfill({ dryRun: false });

    expect(report.failed).toEqual([
      { planId: p.cadence, workspaceId: fx.workspaceId, error: 'boom' },
    ]);
    expect(report.raised.map((r) => r.planId).sort()).toEqual(
      [p.ungated, p.orphaned, p.elsewhere].sort(),
    );
    expect(await awaitingOf(p.cadence)).toEqual([]);
    for (const id of [p.ungated, p.orphaned, p.elsewhere]) {
      expect(await awaitingOf(id)).toHaveLength(1);
    }
  });

  it('an INTERRUPTED run keeps the gates it already raised, and a re-run finishes the rest', async () => {
    await seedPopulation();
    const controller = new AbortController();
    const report = await planGateBackfillService.backfill({
      dryRun: false,
      progressEvery: 1,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.examined === 3) controller.abort();
      },
    });

    expect(report.interrupted).toBe(true);
    expect(report.examined).toBe(3);
    const kept = report.raised.map((r) => r.planId);
    for (const id of kept) expect(await awaitingOf(id)).toHaveLength(1);
    expect(await gateCount()).toBe(1 + kept.length);

    const resumed = await planGateBackfillService.backfill({ dryRun: false });
    expect(resumed.raised.length + kept.length).toBe(4);
    expect(await gateCount()).toBe(5);
  });

  it('a plan that leaves `planned` between the scan and its own transaction is counted, not raised', async () => {
    const kept = await seedPlan(fx);
    const decided = await seedPlan(fx);
    const realRaise = planGateService.raise.bind(planGateService);
    vi.spyOn(planGateService, 'raise').mockImplementation(async (plan, tx) => {
      // Somebody decides the plan after the scan read it as `planned` — committed on
      // its own connection before this plan's raise takes the lock.
      if (plan.id === decided) {
        await adminDb.plan.update({ where: { id: decided }, data: { status: 'approved' } });
      }
      return realRaise(plan, tx);
    });

    const report = await planGateBackfillService.backfill({ dryRun: false });

    expect(report).toMatchObject({ total: 2, notPlanned: 1, failed: [] });
    expect(report.raised.map((r) => r.planId)).toEqual([kept]);
    expect(await awaitingOf(decided)).toEqual([]);
  });
});

describe('the script', () => {
  const capture = () => {
    const lines: string[] = [];
    const errors: string[] = [];
    return {
      lines,
      errors,
      out: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) },
    };
  };

  it('parses --dry-run and --workspace=<id>, and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, workspaceId: undefined });
    expect(parseArgs(['--dry-run', '--workspace=ws1'])).toEqual({
      dryRun: true,
      workspaceId: 'ws1',
    });
    expect(() => parseArgs(['--workspace='])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--apply'])).toThrow(/unknown argument/);
  });

  it('--dry-run reports per-workspace counts and changes nothing', async () => {
    await seedPopulation();
    const gatesBefore = await gateCount();
    const c = capture();

    expect(await run(['--dry-run'], { out: c.out })).toBe(0);

    expect(await gateCount()).toBe(gatesBefore);
    const text = c.lines.join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain(`workspace ${fx.workspaceId}: 3 would raise, 1 already awaiting`);
    expect(text).toContain(`workspace ${other.workspaceId}: 1 would raise`);
    expect(text).toContain('Re-run without --dry-run to apply.');
    expect(text).not.toContain('APPLIED');
  });

  it('a real run reports BEFORE, applies, and re-reports AFTER at zero', async () => {
    await seedPopulation();
    const c = capture();

    expect(await run([`--workspace=${fx.workspaceId}`], { out: c.out })).toBe(0);

    const text = c.lines.join('\n');
    expect(text).toContain(`scope: workspace ${fx.workspaceId}.`);
    expect(text).toMatch(
      /BEFORE[\s\S]*3 would raise[\s\S]*APPLIED[\s\S]*3 raised[\s\S]*AFTER[\s\S]*0 would raise/,
    );
    expect(text).toContain(`routed to ${fx.ownerId}`);
    expect(await gateCount()).toBe(4);
  });

  it('says so when nothing is in scope', async () => {
    const c = capture();
    expect(await run(['--dry-run'], { out: c.out })).toBe(0);
    expect(c.lines.join('\n')).toContain('no `planned` plans in scope.');
  });

  it('flags a gate routed to NOBODY when the workspace has no owner', async () => {
    const id = await seedPlan(fx, { origin: 'cadence' });
    await adminDb.workspaceMembership.updateMany({
      where: { workspaceId: fx.workspaceId },
      data: { role: 'member' },
    });
    const c = capture();
    expect(await run(['--dry-run'], { out: c.out })).toBe(0);
    expect(c.lines.join('\n')).toContain(`plan ${id}`);
    expect(c.lines.join('\n')).toContain('routed to NOBODY');
  });

  it('exits non-zero, naming the plan, when one fails', async () => {
    const id = await seedPlan(fx);
    vi.spyOn(planGateService, 'raise').mockRejectedValue(new Error('boom'));
    const c = capture();
    expect(await run([], { out: c.out })).toBe(1);
    expect(c.errors.join('\n')).toContain(`plan ${id} FAILED — boom`);
  });

  it('exits non-zero and says INTERRUPTED when the signal fires', async () => {
    await seedPlan(fx);
    const controller = new AbortController();
    controller.abort();
    const c = capture();
    expect(await run([], { out: c.out, signal: controller.signal })).toBe(1);
    expect(c.errors.join('\n')).toContain('INTERRUPTED after 0 of 1 plan(s)');
    expect(await gateCount()).toBe(0);
  });
});
