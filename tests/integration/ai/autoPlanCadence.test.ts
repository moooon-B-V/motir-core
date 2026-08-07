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
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemFixture } from '../../fixtures';
import type { PlanStatus } from '@/lib/generated/prisma/client';

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
  await db.$executeRawUnsafe(
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
});

/** Opt a project into auto-planning at a given drain threshold. */
async function enableAutoPlan(projectId: string, threshold = 5): Promise<void> {
  await db.project.update({
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

/** Seed a plan in a given lifecycle state directly (the gate reads status only). */
async function seedPlan(fx: WorkItemFixture, status: PlanStatus): Promise<string> {
  const plan = await db.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      status,
      sourceJobId: `job_seed_${status}`,
    },
  });
  return plan.id;
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
    await db.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        origin: 'user',
        sourceJobId: 'job_user_clicked',
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

describe('Auto-plan cadence — the PAUSED indicator read (MOTIR-1740)', () => {
  /** Attach `count` proposal items to a plan, so the meta line has a size. */
  async function seedItems(
    fx: WorkItemFixture,
    planId: string,
    count: number,
    parentRef?: string,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      await db.planItem.create({
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
    const planId = await seedPlan(fx, 'planned');
    const plannedAt = new Date('2026-07-20T10:00:00.000Z');
    await db.plan.update({ where: { id: planId }, data: { plannedAt } });
    await seedItems(fx, planId, 3);

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
    const planId = await seedPlan(fx, 'generating');
    await seedItems(fx, planId, 2);

    const state = await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(state).toMatchObject({ pending: true, planId, plannedAt: null, itemCount: 2 });
    expect(state.stale).toBe(false);
  });

  it('flags a DRIFTED waiting plan via planStalenessService — the count, not the reason list', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedPlan(fx, 'planned');
    // The proposal's parent is archived after the plan was drafted → the shipped
    // `parent_removed` rule fires. Real drift, computed by the shipped service.
    const parent = await makeItem(fx, { kind: 'story', title: 'Parent that goes away' });
    await db.plan.update({ where: { id: planId }, data: { plannedAt: new Date() } });
    await seedItems(fx, planId, 2, parent.id);
    await db.workItem.update({ where: { id: parent.id }, data: { archivedAt: new Date() } });

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
    const plansBefore = await db.plan.findMany({ orderBy: { id: 'asc' } });
    const itemsBefore = await db.planItem.findMany({ orderBy: { id: 'asc' } });
    const treeBefore = await db.workItem.findMany({ orderBy: { id: 'asc' } });

    await autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx);

    expect(await db.plan.findMany({ orderBy: { id: 'asc' } })).toEqual(plansBefore);
    expect(await db.planItem.findMany({ orderBy: { id: 'asc' } })).toEqual(itemsBefore);
    expect(await db.workItem.findMany({ orderBy: { id: 'asc' } })).toEqual(treeBefore);
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

describe('Auto-plan cadence — provenance and the proposal-only invariant (MOTIR-916)', () => {
  it('opens a generating Plan stamped origin=cadence, bound to the submitted job', async () => {
    const { fx } = await makeDrainedProject();

    const summary = await autoPlanCadenceService.runCadenceSweep();

    const plans = await db.plan.findMany({ where: { projectId: fx.projectId } });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      status: 'generating',
      origin: 'cadence',
      sourceJobId: 'job_cadence_1',
    });
    expect(summary.outcomes[0]).toMatchObject({ planId: plans[0]!.id });
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

    const plan = await db.plan.findFirstOrThrow({ where: { projectId: fx.projectId } });
    expect(plan.origin).toBe('user');
  });

  it('createPlan defaults origin to user, and the DTO/mapper exposes the column', async () => {
    const fx = await makeWorkItemFixture();

    const dto = await plansService.createPlan(fx.projectId, { title: 'By hand' }, fx.ctx);

    expect(dto.origin).toBe('user');
    const row = await db.plan.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.origin).toBe('user');
  });

  it('writes NOTHING to the work-item tree — a fired run produces proposals only', async () => {
    const { fx } = await makeDrainedProject();
    const before = await db.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { id: 'asc' },
    });

    await autoPlanCadenceService.runCadenceSweep();

    const after = await db.workItem.findMany({
      where: { projectId: fx.projectId },
      orderBy: { id: 'asc' },
    });
    // Byte-for-byte identical: no row created, none touched (a `modify` would
    // bump updatedAt). The tree only ever changes when a human approves.
    expect(after).toEqual(before);
    // And no proposal ITEMS yet either — motir-ai appends those via the callback.
    expect(await db.planItem.count()).toBe(0);
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
    expect(await db.plan.count({ where: { projectId: failedProjectId } })).toBe(0);
    // Both projects belong to different workspaces — the sweep really is
    // cross-workspace, not scoped to one tenant.
    expect(a.fx.workspaceId).not.toBe(b.fx.workspaceId);
  });

  it('skips a workspace with no owner rather than throwing — an invariant violation is logged, not fatal', async () => {
    const { fx } = await makeDrainedProject();
    await db.workspaceMembership.deleteMany({ where: { workspaceId: fx.workspaceId } });

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
