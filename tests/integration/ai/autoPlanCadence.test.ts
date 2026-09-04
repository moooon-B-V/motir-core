import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling plan-edit suites).
// EVERYTHING below it is real: a real Postgres, the real cross-workspace
// project scan, the real `countReady` / `findExpandableStubs` reads, the real
// `aiPlanEditsService.submitExpand` → `plansService.createPlan` transaction. So
// what these tests assert about the Plan rows and the work-item tree is what
// production actually writes.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { submitJob } from '@/lib/ai/motirAiClient';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { plansService } from '@/lib/services/plansService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planRepository } from '@/lib/repositories/planRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { PlanTargetImmutableError } from '@/lib/plans/errors';
import { makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemFixture } from '../../fixtures';
import type { PlanStatus } from '@/generated/prisma/client';

// Story 7.13 · MOTIR-916 — the auto-plan CADENCE trigger. A watcher on the 1.6
// cron substrate fires the shipped 7.4 `expand_item` job for a project whose
// ready set has drained below its `aiAutoPlanThreshold`.
//
// What these lock, in the order the sweep decides them:
//   * OPT-IN — a project with `aiAutoPlanEnabled = false` is never even scanned;
//   * the PENDING-PROPOSAL GATE — an undecided plan (`generating` / `planned`)
//     pauses cadence for that project REGARDLESS of what started it, and the
//     predicate is the ONE shared method MOTIR-1740's paused indicator reads;
//   * the THRESHOLD — at/above it nothing fires; below it exactly ONE job does;
//   * the ACTOR — the workspace owner, because a cron tick has no session;
//   * PROVENANCE — the opened Plan is `origin: 'cadence'`, while every
//     request-path submit stays `user`;
//   * the PROPOSAL-ONLY invariant — a fired run leaves the work-item tree byte
//     for byte unchanged; only `Plan` rows appear;
//   * FAILURE ISOLATION — one project's submit blowing up does not stop the
//     sweep for any other project, and nothing is left half-written.
//
// MOTIR-1740 adds the INDICATOR half — `getAutoPlanPauseState`, what the
// AI-planning settings page reads to SAY the cadence is paused. Its `pending` is
// the same `getPendingPlan` verdict gate 1 uses, and the closing test asserts
// that equivalence as SET equality over a sweep: the projects skipped
// `pending_proposal` are exactly the projects the indicator reports as paused.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  // The default stub: every submit succeeds and hands back a job id. Tests that
  // care about failure override it.
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_cadence_1' } as Awaited<
    ReturnType<typeof submitJob>
  >);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Opt a project into auto-planning at a given drain threshold. */
async function enableAutoPlan(projectId: string, threshold = 5): Promise<void> {
  await adminDb.project.update({
    where: { id: projectId },
    data: { aiAutoPlanEnabled: true, aiAutoPlanThreshold: threshold },
  });
}

/**
 * Create a work item through the SHIPPED service path, which is what makes it
 * visible to the two reads the sweep gates on. Both `countReady` and
 * `findExpandableStubs` JOIN `workflow_status` on the item's status KEY, and
 * only `workItemsService.createWorkItem` resolves that key from the project's
 * workflow (`isInitial` → `todo`). A raw repository insert keeps the legacy
 * `work_item.status` column default (`"open"`), which matches no seeded
 * workflow row — so the JOIN drops the item and every gate reads an empty
 * project. Same reason `tests/ready/expansionNudge.test.ts` builds its stubs
 * through the service.
 */
async function makeItem(
  fx: WorkItemFixture,
  input: { kind: 'epic' | 'story' | 'task' | 'subtask'; title: string; parentId?: string },
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: input.kind,
      title: input.title,
      ...(input.parentId ? { parentId: input.parentId } : {}),
    },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/**
 * The canonical cadence-eligible project: opted in, with ONE childless epic as
 * the expandable stub. That single stub is also the whole ready set (a
 * childless, to-start node IS a ready leaf), so `readyCount = 1` — below the
 * default threshold of 5, i.e. drained.
 */
async function makeDrainedProject(
  opts: { name?: string; identifier?: string; threshold?: number } = {},
): Promise<{ fx: WorkItemFixture; stubKey: string }> {
  const fx = await makeWorkItemFixture({
    name: opts.name ?? 'Acme',
    identifier: opts.identifier ?? 'PROD',
  });
  await enableAutoPlan(fx.projectId, opts.threshold ?? 5);
  const stub = await makeItem(fx, { kind: 'epic', title: 'Unexpanded epic' });
  return { fx, stubKey: stub.identifier };
}

/**
 * Seed a plan in a given lifecycle state directly.
 *
 * ⚠️ IT CARRIES ONE PROPOSAL, and that is load-bearing (MOTIR-4124). The gate
 * reads the status AND, for a closed plan, whether it proposes anything: a
 * `planned` plan holding NOTHING is nobody's decision, so it no longer pauses
 * cadence. Seeding a bare row would make every case below assert the gate's
 * verdict for a reason the case is not about.
 */
async function seedPlan(
  fx: WorkItemFixture,
  status: PlanStatus,
  opts: { items?: number } = {},
): Promise<string> {
  const count = opts.items ?? 1;
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      status,
      sourceJobId: `job_seed_${status}`,
      items: {
        create: Array.from({ length: count }, (_, i) => ({
          workspaceId: fx.workspaceId,
          op: 'add' as const,
          proposedFields: { title: `Proposed ${i}`, kind: 'task' },
        })),
      },
    },
  });
  return plan.id;
}

/** Attach `count` proposal items to a plan, so the meta line has a size. */
async function seedItems(
  fx: WorkItemFixture,
  planId: string,
  count: number,
  parentRef?: string,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'add',
        proposedFields: { title: `Proposed ${i}`, kind: 'subtask' },
        blockedByRefs: [],
        ...(parentRef ? { parentRef } : {}),
      },
    });
  }
}

describe('Auto-plan cadence — the opt-in and the drain threshold (MOTIR-916)', () => {
  it('fires exactly ONE expand_item job for a drained, opted-in project, targeting the nominated stub', async () => {
    const { fx, stubKey } = await makeDrainedProject();

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary).toMatchObject({ scanned: 1, fired: 1, skipped: 0, failed: 0 });
    expect(summary.outcomes[0]).toMatchObject({
      projectId: fx.projectId,
      status: 'fired',
      itemKey: stubKey,
      jobId: 'job_cadence_1',
    });
    // ONE job, and it is the shipped `expand_item` kind aimed at the stub.
    expect(submitJob).toHaveBeenCalledTimes(1);
    const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('expand_item');
    expect(context).toMatchObject({ rootItemKey: stubKey });
  });

  it('a project that has NOT opted in is never scanned — no job, no outcome row', async () => {
    const fx = await makeWorkItemFixture();
    await makeItem(fx, { kind: 'epic', title: 'Unexpanded epic' });
    // aiAutoPlanEnabled stays at its default (false).

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary).toMatchObject({ scanned: 0, fired: 0 });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('a ready set AT the threshold fires nothing — the drain condition is strict "below"', async () => {
    // Threshold 1 with exactly one ready leaf: count (1) >= threshold (1).
    const { fx } = await makeDrainedProject({ threshold: 1 });

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary).toMatchObject({ scanned: 1, fired: 0, skipped: 1 });
    expect(summary.outcomes[0]).toEqual({
      projectId: fx.projectId,
      status: 'skipped',
      reason: 'ready_set_healthy',
    });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('an opted-in, drained project with nothing left to expand fires nothing (no false nag)', async () => {
    const fx = await makeWorkItemFixture();
    await enableAutoPlan(fx.projectId);
    // A story WITH a child is not a stub, and the child subtask is not expandable.
    const story = await makeItem(fx, { kind: 'story', title: 'Fully expanded' });
    await makeItem(fx, { kind: 'subtask', title: 'Child', parentId: story.id });

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toEqual({
      projectId: fx.projectId,
      status: 'skipped',
      reason: 'no_expandable_stub',
    });
    expect(submitJob).not.toHaveBeenCalled();
  });
});

describe('Auto-plan cadence — the pending-proposal gate (MOTIR-916)', () => {
  it.each<[PlanStatus]>([['generating'], ['planned']])(
    'a project whose plan is %s is SKIPPED — never stack a second proposal on the reviewer',
    async (status) => {
      const { fx } = await makeDrainedProject();
      await seedPlan(fx, status);

      const summary = await autoPlanCadenceService.runCadenceSweep();

      expect(summary.outcomes[0]).toEqual({
        projectId: fx.projectId,
        status: 'skipped',
        reason: 'pending_proposal',
      });
      expect(submitJob).not.toHaveBeenCalled();
    },
  );

  it.each<[PlanStatus]>([['approved'], ['declined']])(
    'a project whose latest plan is %s is eligible again — declining is the release valve',
    async (status) => {
      const { fx } = await makeDrainedProject();
      await seedPlan(fx, status);

      const summary = await autoPlanCadenceService.runCadenceSweep();

      expect(summary).toMatchObject({ fired: 1 });
      expect(summary.outcomes[0]).toMatchObject({ projectId: fx.projectId, status: 'fired' });
    },
  );

  it('gates on a USER-clicked plan exactly as on a cadence-fired one — origin is not part of the predicate', async () => {
    const { fx } = await makeDrainedProject();
    // A plan a person opened by clicking Expand: origin `user`, still undecided.
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        origin: 'user',
        sourceJobId: 'job_user_clicked',
        // It proposes something — otherwise the gate reads past it for a reason
        // that has nothing to do with `origin` (MOTIR-4124).
        items: {
          create: [
            {
              workspaceId: fx.workspaceId,
              op: 'add',
              proposedFields: { title: 'A proposed card', kind: 'task' },
            },
          ],
        },
      },
    });

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
  });

  it('the gate predicate is the ONE method the paused indicator reads — same answer, same source', async () => {
    const { fx } = await makeDrainedProject();
    // No plan at all → not paused.
    await expect(autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx)).resolves.toBeNull();

    const planId = await seedPlan(fx, 'planned');
    const pending = await autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx);
    expect(pending).toMatchObject({ id: planId, status: 'planned' });

    // And that same predicate is what makes the sweep skip — one source of truth.
    const summary = await autoPlanCadenceService.runCadenceSweep();
    expect(summary.outcomes[0]).toMatchObject({ reason: 'pending_proposal' });
  });

  it('reports the NEWEST undecided plan when a decided one precedes it', async () => {
    const { fx } = await makeDrainedProject();
    await seedPlan(fx, 'declined');
    const newest = await seedPlan(fx, 'generating');

    const pending = await autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx);

    expect(pending?.id).toBe(newest);
  });
});

describe('Auto-plan cadence — an UNFILLABLE plan is not a pending proposal (MOTIR-3051)', () => {
  // A `generating` plan with NO producer and NO proposals is nobody's decision.
  //
  // The reported path is the permission split `agent-authored-plans.md` Q2
  // records: `create_plan` asserts `work_item:edit` and `add_plan_items` asserts
  // `ai:view_plan`, so a grant holding the first and not the second — exactly
  // `CLI_TOKEN_GRANT` — can OPEN a plan and is refused on its first append. Q2
  // called that "an empty plan and nothing more". It is more than nothing: the
  // gate below reads `generating` as undecided, so that orphan paused the
  // project's cadence indefinitely, with no surface saying why.
  //
  // The same shape arrives without any permission involved. A generation job
  // that dies before its first append leaves its plan `generating` forever —
  // `aiPlanEditsService.resolveJobState` says so in its own doc comment
  // ("nothing writes a terminal plan state on failure") — which is why the fix
  // is at the GATE and not at the door.
  //
  // What separates the two is a PRODUCER, not a count: `sourceJobId` is set by
  // every generator submit and null on every agent-authored plan. That
  // distinction is load-bearing rather than decorative — see the second test.

  /** The plan an agent-authored `create_plan` leaves behind: no job, no items. */
  async function seedUnfillablePlan(fx: WorkItemFixture): Promise<string> {
    const plan = await adminDb.plan.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, status: 'generating' },
    });
    return plan.id;
  }

  it('does NOT pause cadence — a plan with no producer and no proposals gates nothing', async () => {
    const { fx, stubKey } = await makeDrainedProject();
    await seedUnfillablePlan(fx);

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary).toMatchObject({ scanned: 1, fired: 1, skipped: 0 });
    expect(summary.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });

  it('and the paused INDICATOR agrees — one predicate, two consumers', async () => {
    const { fx } = await makeDrainedProject();
    await seedUnfillablePlan(fx);

    await expect(autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx)).resolves.toBeNull();
    await expect(
      autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ pending: false, planId: null });
  });

  it('an in-flight GENERATION still pauses while its plan is empty — the tick is idempotent', async () => {
    // `autoPlanCadenceTick` is `retryPolicy: 'idempotent'` on exactly this
    // ground: "a project that already fired now HAS an undecided plan, so the
    // gate skips it on the re-run". Between `submitExpand`'s createPlan and
    // motir-ai's first append that plan holds ZERO items, so a rule keyed on the
    // COUNT alone would let an Inngest retry fire a second job at the same stub.
    // The producer is what the gate reads.
    const { fx } = await makeDrainedProject();
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'generating',
        sourceJobId: 'job_still_running',
      },
    });

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('an unfillable plan carrying proposals still pauses — items are a decision to make', async () => {
    // Not reachable through the MCP door today (the token refused on append is
    // the reason the plan is empty), but the predicate must not read "no job"
    // as "no proposal": the internal generator route appends through the same
    // rows, and a plan with proposals in it is something a person owes an answer
    // on however it was filled.
    const { fx } = await makeDrainedProject();
    const planId = await seedUnfillablePlan(fx);
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'add',
        proposedFields: { title: 'Proposed', kind: 'subtask' },
        blockedByRefs: [],
      },
    });

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
  });

  it('does not MASK an older plan that is genuinely waiting — the gate reads past it', async () => {
    // `findUndecidedByProject` returns ONE row, newest first. Skipping the
    // orphan in the caller rather than in the WHERE clause would answer "not
    // paused" for a project whose real `planned` proposal is sitting one row
    // down — trading a permanent pause for a stacked proposal, which is the
    // thing the gate exists to prevent.
    const { fx } = await makeDrainedProject();
    const waiting = await seedPlan(fx, 'planned');
    await seedUnfillablePlan(fx);

    const pending = await autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx);

    expect(pending?.id).toBe(waiting);
    const summary = await autoPlanCadenceService.runCadenceSweep();
    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
  });

  it('is the plan the SHIPPED create_plan seam actually writes — not a hand-built row', async () => {
    // The row `lib/mcp/tools/authorPlan.ts` leaves when the append that follows
    // it is refused: the real service, the real transaction, the field set that
    // adapter passes (no `sourceJobId`, `authorSource: 'mcp'`).
    const { fx, stubKey } = await makeDrainedProject();
    const plan = await plansService.createPlan(
      fx.projectId,
      {
        title: 'Correction from a run',
        summary: null,
        createdById: fx.ctx.userId,
        authorSource: 'mcp',
        authorHarness: 'Claude Code',
        authorModel: 'claude-opus-5[1m]',
      },
      fx.ctx,
    );
    expect(plan).toMatchObject({ status: 'generating', itemCount: 0 });

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });
});

describe('Auto-plan cadence — the PAUSED indicator read (MOTIR-1740)', () => {
  it('reports NOT paused when the project has no undecided plan', async () => {
    const { fx } = await makeDrainedProject();
    await seedPlan(fx, 'declined');

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(state).toEqual({
      pending: false,
      planId: null,
      plannedAt: null,
      itemCount: 0,
      stale: false,
      staleCount: 0,
    });
  });

  it('reports the waiting plan — its id, when it was planned, and how many items it proposes', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'planned', { items: 3 });
    const plannedAt = new Date('2026-07-20T10:00:00.000Z');
    await adminDb.plan.update({ where: { id: planId }, data: { plannedAt } });

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(state).toEqual({
      pending: true,
      planId,
      plannedAt: plannedAt.toISOString(),
      itemCount: 3,
      stale: false,
      staleCount: 0,
    });
  });

  it('is paused by a still-GENERATING plan too — no plannedAt yet, and never stale', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'generating', { items: 2 });

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(state).toMatchObject({ pending: true, planId, plannedAt: null, itemCount: 2 });
    expect(state.stale).toBe(false);
  });

  it('flags a DRIFTED waiting plan via planStalenessService — the count, not the reason list', async () => {
    const { fx } = await makeDrainedProject();
    // `items: 0` here, because this case seeds its own — they need a parentRef
    // that does not exist yet when the plan row is written.
    const planId = await seedPlan(fx, 'planned', { items: 0 });
    // The proposal's parent is archived after the plan was drafted → the shipped
    // `parent_removed` rule fires. Real drift, computed by the shipped service.
    const parent = await makeItem(fx, { kind: 'story', title: 'Parent that goes away' });
    await adminDb.plan.update({ where: { id: planId }, data: { plannedAt: new Date() } });
    await seedItems(fx, planId, 2, parent.id);
    await adminDb.workItem.update({ where: { id: parent.id }, data: { archivedAt: new Date() } });

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(state).toMatchObject({
      pending: true,
      planId,
      itemCount: 2,
      stale: true,
      staleCount: 2,
    });
  });

  it('degrades to not-stale when the staleness read fails — it WARNS, it never gates', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'planned');
    await seedItems(fx, planId, 1);
    vi.spyOn(planStalenessService, 'computePlanStaleness').mockRejectedValueOnce(
      new Error('staleness read blew up'),
    );

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    // The page still learns cadence is paused — the drift line is what's lost.
    expect(state).toMatchObject({ pending: true, planId, stale: false, staleCount: 0 });
  });

  it('is tenant-scoped — another workspace’s member gets 404-not-403, never the plan', async () => {
    const { fx } = await makeDrainedProject({ name: 'Acme', identifier: 'AAA' });
    await seedPlan(fx, 'planned');
    const other = await makeWorkItemFixture({ name: 'Beta', identifier: 'BBB' });

    // Not-found, never access-denied: the project's existence does not leak to
    // another tenant (finding #26), and the route layer maps this to a 404.
    await expect(
      autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, other.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('writes nothing — the indicator is a pure read', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'planned');
    await seedItems(fx, planId, 2);
    const plansBefore = await adminDb.plan.findMany({ orderBy: { id: 'asc' } });
    const itemsBefore = await adminDb.planItem.findMany({ orderBy: { id: 'asc' } });
    const treeBefore = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });

    await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    const planRows = await adminDb.plan.findMany({ orderBy: { id: 'asc' } });
    expect(planRows).toEqual(plansBefore);
    const planItemRows = await adminDb.planItem.findMany({ orderBy: { id: 'asc' } });
    expect(planItemRows).toEqual(itemsBefore);
    const workItemRows = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });
    expect(workItemRows).toEqual(treeBefore);
  });

  it('ONE predicate, TWO consumers — the trigger skips exactly the projects the indicator calls paused', async () => {
    // Three opted-in, drained projects in three tenants: one with an undecided
    // plan, one with a decided plan, one with no plan at all.
    const paused = await makeDrainedProject({ name: 'Acme', identifier: 'AAA' });
    const decided = await makeDrainedProject({ name: 'Beta', identifier: 'BBB' });
    const virgin = await makeDrainedProject({ name: 'Ceta', identifier: 'CCC' });
    await seedPlan(paused.fx, 'planned');
    await seedPlan(decided.fx, 'approved');

    const fixtures = [paused, decided, virgin];
    const indicator = new Map(
      await Promise.all(
        fixtures.map(
          async ({ fx }) =>
            [
              fx.projectId,
              (await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx)).pending,
            ] as const,
        ),
      ),
    );

    const summary = await autoPlanCadenceService.runCadenceSweep();

    // Set equality, both directions: the sweep's `pending_proposal` skips are
    // EXACTLY the projects the settings page would show as paused.
    const gated = summary.outcomes
      .filter((o) => o.status === 'skipped' && o.reason === 'pending_proposal')
      .map((o) => o.projectId)
      .sort();
    const reportedPaused = [...indicator.entries()]
      .filter(([, pending]) => pending)
      .map(([projectId]) => projectId)
      .sort();
    expect(gated).toEqual(reportedPaused);
    expect(gated).toEqual([paused.fx.projectId]);
    // …and the other two really did fire, so "not paused" means "cadence runs".
    expect(summary).toMatchObject({ scanned: 3, fired: 2, skipped: 1 });
  });
});

describe('Auto-plan cadence — a STALE plan is UNDECIDED, and still pauses (MOTIR-4129)', () => {
  // `stale` is the FIFTH `PlanStatus` member (MOTIR-3574 / MOTIR-3578,
  // AMENDMENT 9), and `prisma/schema.prisma` says what it is in one sentence:
  // "It is NOT terminal and NOT decided: the plan is live and awaiting action."
  // It is reachable only from `planned`, so a plan wearing it is BY
  // CONSTRUCTION one that already reached a reviewer and is being held.
  //
  // The gate spells "undecided" as a MEMBERSHIP LIST, and that list was not
  // widened when the enum grew — so the plan for which the question matters
  // MOST read as decided. AMENDMENT 9 met the same proxy once, for
  // `computePlanStaleness`, and named it: "the guard's predicate was a proxy
  // for *is this plan still awaiting a decision?*, and adding a fifth status is
  // what makes the proxy and the intent come apart."
  //
  // The harm is the MIRROR of MOTIR-3051 / MOTIR-3064 / MOTIR-3189, which each
  // took a plan that gated when it should not have. This one did not gate when
  // it should: the tick fires a second expand beside a proposal a reviewer is
  // already holding, and — one predicate, two consumers — the paused indicator
  // reports nothing while a Stale pill sits on the Plans list.

  /**
   * Reach `stale` the way production does — the LAZY BACKSTOP (AMENDMENT 9 D5),
   * which is the card's own reproduction: a `modify` target reaches a terminal
   * status under a `planned` plan, `approvePlan` refuses with
   * `PlanTargetImmutableError`, and its catch writes the status on the way out.
   *
   * Every other case here seeds the row directly, which is cheaper and asserts
   * the same predicate. This one exists so the suite carries at least one plan
   * that no test put into the status.
   */
  async function staleByApproveRefusal(fx: WorkItemFixture): Promise<string> {
    const target = await makeItem(fx, { kind: 'task', title: 'Finished under the plan' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Rework' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'A new title' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await adminDb.workItem.update({ where: { id: target.id }, data: { status: 'done' } });

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      PlanTargetImmutableError,
    );
    const row = await adminDb.plan.findUnique({ where: { id: plan.id } });
    expect(row!.status).toBe('stale');
    return plan.id;
  }

  it('the REPOSITORY read returns a project whose only plan is `stale` — it is undecided', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'stale');

    const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRepository.findUndecidedByProject(fx.projectId, fx.workspaceId, tx),
    );

    expect(row).toMatchObject({ id: planId, status: 'stale' });
  });

  it.each<[PlanStatus]>([['approved'], ['declined']])(
    'and still returns null for a project holding only a %s plan — the arm that keeps the widening honest',
    async (status) => {
      const { fx } = await makeDrainedProject();
      await seedPlan(fx, status);

      const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planRepository.findUndecidedByProject(fx.projectId, fx.workspaceId, tx),
      );

      expect(row).toBeNull();
    },
  );

  it('the TICK skips such a project with `pending_proposal` — no second plan beside the first', async () => {
    const { fx } = await makeDrainedProject();
    await seedPlan(fx, 'stale');

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toEqual({
      projectId: fx.projectId,
      status: 'skipped',
      reason: 'pending_proposal',
    });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('and `getPendingPlan` returns it — the indicator and the trigger still cannot disagree', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'stale');

    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: planId, status: 'stale' });
    await expect(
      autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ pending: true, planId });
  });

  it('end to end through the SHIPPED path — approve refuses, and cadence stays paused', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await staleByApproveRefusal(fx);

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
    expect(submitJob).not.toHaveBeenCalled();
    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: planId, status: 'stale' });
  });

  it('and the indicator still COUNTS its drift — the SIBLING guard the widening reaches', async () => {
    // ⚠️ THE SWEEP HIT. `staleCountFor` here is the mirror of
    // `app/(authed)/plans/planRowView.ts`'s function of the same name, and its
    // own doc comment says so — but the mirror widened to `planned | stale`
    // with AMENDMENT 9 D3 and this copy did not. The divergence was
    // unreachable while the predicate above could never hand this consumer a
    // `stale` plan; widening that predicate is what makes it live. Left alone,
    // the settings page would report the project paused and its drift as ZERO,
    // on the one plan most likely to carry some.
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'planned', { items: 0 });
    const parent = await makeItem(fx, { kind: 'story', title: 'Parent that goes away' });
    await adminDb.plan.update({
      where: { id: planId },
      data: { status: 'stale', plannedAt: new Date() },
    });
    await seedItems(fx, planId, 2, parent.id);
    await adminDb.workItem.update({ where: { id: parent.id }, data: { archivedAt: new Date() } });

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(state).toMatchObject({ pending: true, planId, stale: true, staleCount: 2 });
  });

  it('a DECIDED plan still short-circuits that count — the widening did not become "always ask"', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'planned', { items: 1 });
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
    const engine = vi.spyOn(planStalenessService, 'computePlanStaleness');

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(state).toMatchObject({ pending: false, staleCount: 0 });
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('Auto-plan cadence — provenance and the proposal-only invariant (MOTIR-916)', () => {
  it('opens a generating Plan stamped origin=cadence, bound to the submitted job', async () => {
    const { fx } = await makeDrainedProject();

    const summary = await autoPlanCadenceService.runCadenceSweep();

    const plans = await adminDb.plan.findMany({ where: { projectId: fx.projectId } });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      status: 'generating',
      origin: 'cadence',
      sourceJobId: 'job_cadence_1',
    });
    expect(summary.outcomes[0]).toMatchObject({ planId: plans[0]!.id });
  });

  it('records NO requester on a cadence plan — the owner’s credential is not a request (MOTIR-2986)', async () => {
    const { fx } = await makeDrainedProject();

    await autoPlanCadenceService.runCadenceSweep();

    const plan = await adminDb.plan.findFirstOrThrow({ where: { projectId: fx.projectId } });
    // The sweep runs under the PROJECT OWNER's credential — `runCadenceSweep`
    // builds `{ userId: owner.userId }` so the job HAS one — and nobody clicked
    // anything. `createdById` must therefore stay null: a value here would
    // attribute to that owner a request they never made, on the one plan whose
    // whole point is that no person asked.
    expect(plan.createdById).toBeNull();
    // …and the abstention is real rather than a fixture with nobody to record:
    // the owner exists, and is exactly who a naive `ctx.userId` default would
    // have written.
    expect(fx.ownerId).toBeTruthy();
    expect(plan.origin).toBe('cadence');
  });

  it('records the AUTHOR as `native · Motir` on both arms — it does not vary with who asked (MOTIR-2996)', async () => {
    // The cadence arm and the request arm differ in `origin` and `createdById`
    // and in NOTHING ELSE about authorship: motir-ai writes the tree either way,
    // so the plan RECORDS who wrote it rather than leaving the Plans surface to
    // infer it from `sourceJobId != null` — an inference that answers WHICH JOB
    // and holds only while a motir-ai job is the sole non-MCP writer of a `Plan`.
    const { fx: cadenceFx } = await makeDrainedProject();
    await autoPlanCadenceService.runCadenceSweep();
    const cadencePlan = await adminDb.plan.findFirstOrThrow({
      where: { projectId: cadenceFx.projectId },
    });

    const requestFx = await makeWorkItemFixture();
    const stub = await makeItem(requestFx, { kind: 'epic', title: 'Unexpanded epic' });
    await aiPlanEditsService.submitExpand(stub.identifier, {
      userId: requestFx.ownerId,
      workspaceId: requestFx.workspaceId,
      projectId: requestFx.projectId,
      project: requestFx.project,
    });
    const requestPlan = await adminDb.plan.findFirstOrThrow({
      where: { projectId: requestFx.projectId },
    });

    for (const plan of [cadencePlan, requestPlan]) {
      expect(plan.authorSource).toBe('native');
      expect(plan.authorHarness).toBe('Motir');
      // Null MODEL, deliberately: the planning LLM is motir-ai's
      // (`PlanningRun.model`), motir-core does not know it, and
      // `work-item-provenance.md` Decision 6 strips a native model at the read
      // boundary anyway — so a value here could never be spent.
      expect(plan.authorModel).toBeNull();
    }
    // The two rows really are the two arms, so this is not one path asserted twice.
    expect(cadencePlan.origin).toBe('cadence');
    expect(requestPlan.origin).toBe('user');
  });

  it('a request-path submit stays origin=user — the default, so no existing caller changed behaviour', async () => {
    const fx = await makeWorkItemFixture();
    const stub = await makeItem(fx, { kind: 'epic', title: 'Unexpanded epic' });

    await aiPlanEditsService.submitExpand(stub.identifier, {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    });

    const plan = await adminDb.plan.findFirstOrThrow({ where: { projectId: fx.projectId } });
    expect(plan.origin).toBe('user');
    // The other arm of the same decision (MOTIR-2986): a request path DOES have
    // a requester — somebody clicked Expand — so the acting user is recorded.
    expect(plan.createdById).toBe(fx.ownerId);
  });

  it('createPlan defaults origin to user, and the DTO/mapper exposes the column', async () => {
    const fx = await makeWorkItemFixture();

    const dto = await plansService.createPlan(fx.projectId, { title: 'By hand' }, fx.ctx);

    expect(dto.origin).toBe('user');
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.origin).toBe('user');
  });

  it('writes NOTHING to the work-item tree — a fired run produces proposals only', async () => {
    const { fx } = await makeDrainedProject();
    const before = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { id: 'asc' },
    });

    await autoPlanCadenceService.runCadenceSweep();

    const after = await adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { id: 'asc' },
    });
    // Byte-for-byte identical: no row created, none touched (a `modify` would
    // bump updatedAt). The tree only ever changes when a human approves.
    expect(after).toEqual(before);
    // And no proposal ITEMS yet either — motir-ai appends those via the callback.
    const planItemCount = await adminDb.planItem.count();
    expect(planItemCount).toBe(0);
  });
});

describe('Auto-plan cadence — the actor and failure isolation (MOTIR-916)', () => {
  it('submits as the workspace OWNER — a cron tick has no session to borrow', async () => {
    const { fx } = await makeDrainedProject();

    await autoPlanCadenceService.runCadenceSweep();

    const [, tenant, , actor] = vi.mocked(submitJob).mock.calls[0]!;
    expect(actor).toEqual({ userId: fx.ownerId });
    expect(tenant).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: fx.projectIdentifier,
    });
  });

  it('one project failing does NOT abort the sweep — the others still fire, and it retries next tick', async () => {
    const a = await makeDrainedProject({ name: 'Acme', identifier: 'AAA' });
    const b = await makeDrainedProject({ name: 'Beta', identifier: 'BBB' });

    vi.mocked(submitJob)
      .mockRejectedValueOnce(new Error('motir-ai unreachable'))
      .mockResolvedValueOnce({ jobId: 'job_ok' } as Awaited<ReturnType<typeof submitJob>>);

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary).toMatchObject({ scanned: 2, fired: 1, failed: 1 });
    const failed = summary.outcomes.find((o) => o.status === 'failed');
    const fired = summary.outcomes.find((o) => o.status === 'fired');
    expect(failed).toMatchObject({ error: 'motir-ai unreachable' });
    expect(fired).toBeDefined();
    // The failed project got NO Plan row — the submit-then-open ordering means a
    // failed submit leaves no orphan behind, so the next tick sees it as
    // eligible again rather than gated by a phantom pending proposal.
    const failedProjectId = (failed as { projectId: string }).projectId;
    const planCount = await adminDb.plan.count({ where: { projectId: failedProjectId } });
    expect(planCount).toBe(0);
    // Both projects belong to different workspaces — the sweep really is
    // cross-workspace, not scoped to one tenant.
    expect(a.fx.workspaceId).not.toBe(b.fx.workspaceId);
  });

  it('skips a workspace with no owner rather than throwing — an invariant violation is logged, not fatal', async () => {
    const { fx } = await makeDrainedProject();
    await adminDb.workspaceMembership.deleteMany({ where: { workspaceId: fx.workspaceId } });

    const summary = await autoPlanCadenceService.runCadenceSweep();

    expect(summary.outcomes[0]).toEqual({
      projectId: fx.projectId,
      status: 'skipped',
      reason: 'no_owner',
    });
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('pages the cross-workspace scan and fires for every project on every page', async () => {
    const a = await makeDrainedProject({ name: 'Acme', identifier: 'AAA' });
    const b = await makeDrainedProject({ name: 'Beta', identifier: 'BBB' });
    const c = await makeDrainedProject({ name: 'Ceta', identifier: 'CCC' });

    // pageSize 1 forces three pages plus the terminating empty read.
    const summary = await autoPlanCadenceService.runCadenceSweep({ pageSize: 1 });

    expect(summary).toMatchObject({ scanned: 3, fired: 3, failed: 0 });
    expect(summary.outcomes.map((o) => o.projectId).sort()).toEqual(
      [a.fx.projectId, b.fx.projectId, c.fx.projectId].sort(),
    );
  });

  it('skips a project that vanished between the scan and the per-project read', async () => {
    const { fx } = await makeDrainedProject();
    // Drive the per-project half directly with an id that no longer exists —
    // the race the sweep must survive (a project deleted mid-tick).
    const outcome = await autoPlanCadenceService.runForProject({
      id: 'pj_gone',
      workspaceId: fx.workspaceId,
      aiAutoPlanThreshold: 5,
    });

    expect(outcome).toEqual({ projectId: 'pj_gone', status: 'skipped', reason: 'project_gone' });
  });
});
