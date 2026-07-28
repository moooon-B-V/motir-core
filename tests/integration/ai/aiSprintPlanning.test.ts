import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling plan-edit and cadence
// suites). EVERYTHING below it is real: a real Postgres, the real Epic-4
// `sprintsService.createSprint` / `backlogService.bulkAssignToSprint` writes,
// the real workflow terminal-status read and the real `is_blocked_by` edges. So
// what these tests assert about the created sprints and their membership is
// what production actually writes.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import {
  aiSprintPlanningService,
  SprintPlanApproveError,
  SprintPlanningDisabledError,
} from '@/lib/services/aiSprintPlanningService';
import { SprintAssignmentValidationError } from '@/lib/ai/sprintAssignment';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemFixture } from '../../fixtures';
import type { ProjectContext } from '@/lib/projects';
import type { SprintAssignmentDelta } from '@/lib/ai/types';

// Subtask 7.13.5 · MOTIR-918 — the motir-core half of AI sprint planning: submit
// the `plan_sprint` job, and behind a HUMAN approve persist the proposed packing
// through the SHIPPED Epic-4 sprint services.
//
// What these lock:
//   * the SUBMIT — the project's `aiSprintLengthDays` rides the envelope, the
//     opt-in flag gates it, and the shared method is the one path;
//   * RE-VALIDATE, DON'T RE-PACK — the approved (possibly edited) packing is
//     what persists, checked independently of the planner against live rows;
//   * the four semantic rejections, each BEFORE any write;
//   * that a BLOCKED item in a later sprint is legal — the packing is
//     dependency-aware, not ready-set-only;
//   * ATOMICITY — a failure part-way through leaves NO sprint and NO assignment;
//   * REUSE — the rows carry the Epic-4 writes' side effects (project-global
//     sequence, backlog ranks, revisions), not a re-implemented sprint create.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  hostStories.clear();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_sprint_1' });
});

afterAll(async () => {
  await db.$disconnect();
});

/** The `ProjectContext` the service takes (session user + active project). */
function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

async function enableSprintPlanning(projectId: string, lengthDays = 2): Promise<void> {
  await db.project.update({
    where: { id: projectId },
    data: { aiSprintPlanningEnabled: true, aiSprintLengthDays: lengthDays },
  });
}

/**
 * Create a work item through the SHIPPED service path — the same reason the
 * cadence suite does: only `createWorkItem` resolves the project's workflow
 * initial status onto the row, and the approve's terminal-status check reads
 * that column.
 */
async function makeItem(
  fx: WorkItemFixture,
  input: { kind: 'epic' | 'story' | 'task' | 'subtask' | 'bug'; title: string; parentId?: string },
): Promise<{ id: string; identifier: string }> {
  // A subtask REQUIRES a parent (`TYPES_REQUIRING_PARENT`), so one host story
  // per fixture is created on demand. The scaffold is a container, never packed.
  const parentId = input.parentId ?? (input.kind === 'subtask' ? await hostStoryId(fx) : undefined);
  const dto = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: input.kind,
      title: input.title,
      ...(parentId ? { parentId } : {}),
    },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

const hostStories = new Map<string, string>();

/** The per-project host story every parentless subtask hangs under. */
async function hostStoryId(fx: WorkItemFixture): Promise<string> {
  const cached = hostStories.get(fx.projectId);
  if (cached) return cached;
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Host story' },
    fx.ctx,
  );
  hostStories.set(fx.projectId, story.id);
  return story.id;
}

/** Build a well-formed packing over `sprints` (each an ordered key list). */
function packing(sprints: string[][], over: Partial<SprintAssignmentDelta> = {}): unknown {
  return {
    deltaVersion: 'v1',
    sprintLengthDays: 2,
    capacityMinutes: 720,
    agentMinutesPerDay: 360,
    itemCount: sprints.flat().length,
    totalEstimateMinutes: 0,
    unestimatedKeys: [],
    oversizedKeys: [],
    sprints: sprints.map((itemKeys, i) => ({
      tempId: `sprint:${i + 1}`,
      name: `Sprint ${i + 1}`,
      lengthDays: 2,
      itemKeys,
      totalEstimateMinutes: 0,
      capacityMinutes: 720,
      oversizedKeys: [],
      rationale: 'test packing',
    })),
    ...over,
  };
}

describe('AI sprint planning — the submit (MOTIR-918)', () => {
  it('submits a plan_sprint job carrying the project cadence, and returns the jobId', async () => {
    const fx = await makeWorkItemFixture();
    await enableSprintPlanning(fx.projectId, 3);

    const result = await aiSprintPlanningService.submitSprintPlan(projectCtx(fx));

    expect(result).toEqual({ jobId: 'job_sprint_1' });
    expect(submitJob).toHaveBeenCalledTimes(1);
    const [kind, tenant, context, actor] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('plan_sprint');
    // The cadence rides the envelope, so motir-ai reads the project's sprint
    // length from the REQUEST and never from motir-core config directly.
    expect(context).toEqual({ sprintPlanning: { sprintLengthDays: 3 } });
    expect(tenant).toMatchObject({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectKey: fx.projectIdentifier,
    });
    expect(actor).toEqual({ userId: fx.ownerId });
  });

  it('refuses with a typed error when sprint planning is NOT enabled — and submits nothing', async () => {
    const fx = await makeWorkItemFixture();

    await expect(aiSprintPlanningService.submitSprintPlan(projectCtx(fx))).rejects.toBeInstanceOf(
      SprintPlanningDisabledError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('opens NO Plan — plan_sprint proposes sprint membership, not work items', async () => {
    const fx = await makeWorkItemFixture();
    await enableSprintPlanning(fx.projectId);

    await aiSprintPlanningService.submitSprintPlan(projectCtx(fx));

    expect(await db.plan.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});

describe('AI sprint planning — approve persists through the Epic-4 services (MOTIR-918)', () => {
  it('creates the sprints in order, resolves tempIds → real ids, and assigns the members', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });
    const b = await makeItem(fx, { kind: 'task', title: 'B' });
    const c = await makeItem(fx, { kind: 'bug', title: 'C' });

    const result = await aiSprintPlanningService.approveSprintPlan(
      'job_sprint_1',
      packing([[a.identifier, b.identifier], [c.identifier]]),
      projectCtx(fx),
    );

    expect(result.assigned).toBe(3);
    expect(result.sprints.map((s) => s.tempId)).toEqual(['sprint:1', 'sprint:2']);
    expect(result.sprints.map((s) => s.assignedCount)).toEqual([2, 1]);

    const rows = await db.sprint.findMany({
      where: { projectId: fx.projectId },
      orderBy: { sequence: 'asc' },
    });
    expect(rows).toHaveLength(2);
    // The Epic-4 create owns the naming + ordinal, so the sprints come out with
    // the PROJECT-global sequence — not the proposal's 1-based position.
    expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(rows.every((r) => r.state === 'planned')).toBe(true);
    expect(result.sprints.map((s) => s.id)).toEqual(rows.map((r) => r.id));

    const items = await db.workItem.findMany({
      where: { projectId: fx.projectId },
      select: { identifier: true, sprintId: true, backlogRank: true },
    });
    const bySprint = (id: string) =>
      items
        .filter((i) => i.sprintId === id)
        .map((i) => i.identifier)
        .sort();
    expect(bySprint(rows[0]!.id)).toEqual([a.identifier, b.identifier].sort());
    expect(bySprint(rows[1]!.id)).toEqual([c.identifier]);
    // The Epic-4 assignment ranks members as it appends, so the proposal's
    // topological order survives into the sprint's backlog order.
    const ranks = items.filter((i) => i.sprintId === rows[0]!.id);
    expect(ranks.every((r) => r.backlogRank !== null)).toBe(true);
  });

  it('APPENDS to a project that already has sprints — the ordinal continues, it does not restart', async () => {
    const fx = await makeWorkItemFixture();
    await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });

    await aiSprintPlanningService.approveSprintPlan(
      'job_sprint_1',
      packing([[a.identifier]]),
      projectCtx(fx),
    );

    const rows = await db.sprint.findMany({
      where: { projectId: fx.projectId },
      orderBy: { sequence: 'asc' },
    });
    // The packer names its sprints positionally ("Sprint 1"), which would have
    // collided here; the generated name is dropped so the project's real
    // ordinal wins.
    expect(rows.map((r) => r.name)).toEqual(['Sprint 1', 'Sprint 2']);
  });

  it('HONOURS a human-edited sprint name — the approve persists what was approved', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });

    const edited = packing([[a.identifier]]) as { sprints: Array<{ name: string }> };
    edited.sprints[0]!.name = 'Hardening week';

    await aiSprintPlanningService.approveSprintPlan('job_sprint_1', edited, projectCtx(fx));

    const rows = await db.sprint.findMany({ where: { projectId: fx.projectId } });
    expect(rows.map((r) => r.name)).toEqual(['Hardening week']);
  });

  it('an EMPTY packing is a valid no-op — no sprint, no error', async () => {
    const fx = await makeWorkItemFixture();

    const result = await aiSprintPlanningService.approveSprintPlan(
      'job_sprint_1',
      packing([]),
      projectCtx(fx),
    );

    expect(result).toEqual({ sprints: [], assigned: 0 });
    expect(await db.sprint.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('reads the JOB RESULT when the caller sends no edited packing', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_sprint_1',
      status: 'succeeded',
      result: {
        envelopeVersion: 'v1',
        jobKind: 'plan_sprint',
        planDelta: { operations: [] },
        summary: 'packed 1 item',
        usage: { model: null, inputTokens: 0, outputTokens: 0 },
        sprintAssignment: packing([[a.identifier]]) as SprintAssignmentDelta,
      },
      error: null,
    });

    const result = await aiSprintPlanningService.approveSprintPlan(
      'job_sprint_1',
      undefined,
      projectCtx(fx),
    );

    expect(result.assigned).toBe(1);
  });

  it('does NOT re-pack: the EDITED packing wins over the job result', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });
    const b = await makeItem(fx, { kind: 'subtask', title: 'B' });
    // The job proposed both items in ONE sprint; the human split them in two.
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_sprint_1',
      status: 'succeeded',
      result: {
        envelopeVersion: 'v1',
        jobKind: 'plan_sprint',
        planDelta: { operations: [] },
        summary: 'packed 2 items',
        usage: { model: null, inputTokens: 0, outputTokens: 0 },
        sprintAssignment: packing([[a.identifier, b.identifier]]) as SprintAssignmentDelta,
      },
      error: null,
    });

    const result = await aiSprintPlanningService.approveSprintPlan(
      'job_sprint_1',
      packing([[a.identifier], [b.identifier]]),
      projectCtx(fx),
    );

    // Two sprints, not one — the human's edit survived, and the scheduler was
    // never re-consulted.
    expect(result.sprints).toHaveLength(2);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('rejects an approve whose job carries no sprint-assignment result', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(getJob).mockResolvedValue({
      jobId: 'job_sprint_1',
      status: 'failed',
      result: null,
      error: null,
    });

    await expect(
      aiSprintPlanningService.approveSprintPlan('job_sprint_1', undefined, projectCtx(fx)),
    ).rejects.toBeInstanceOf(SprintPlanApproveError);
  });
});

describe('AI sprint planning — the semantic re-validation, BEFORE any write (MOTIR-918)', () => {
  it('rejects an unknown / cross-project item key and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const mine = await makeItem(fx, { kind: 'subtask', title: 'A' });
    const theirs = await makeItem(other, { kind: 'subtask', title: 'Theirs' });

    await expect(
      aiSprintPlanningService.approveSprintPlan(
        'job_sprint_1',
        packing([[mine.identifier, theirs.identifier]]),
        projectCtx(fx),
      ),
    ).rejects.toThrow(/unknown work item/);

    expect(await db.sprint.count()).toBe(0);
    // A key from another tenant is indistinguishable from a typo — 400, no
    // existence leak, nothing written.
    expect(await db.workItem.count({ where: { sprintId: { not: null } } })).toBe(0);
  });

  it('rejects a CONTAINER member — an epic/story rolls its children up, it is not scheduled', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await makeItem(fx, { kind: 'epic', title: 'E' });
    const story = await makeItem(fx, { kind: 'story', title: 'S', parentId: epic.id });

    await expect(
      aiSprintPlanningService.approveSprintPlan(
        'job_sprint_1',
        packing([[story.identifier]]),
        projectCtx(fx),
      ),
    ).rejects.toThrow(/only leaf work/);
    expect(await db.sprint.count()).toBe(0);
  });

  it('rejects an item that is already FINISHED — there is nothing left to schedule', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });
    await db.workItem.update({ where: { id: a.id }, data: { status: 'done' } });

    await expect(
      aiSprintPlanningService.approveSprintPlan(
        'job_sprint_1',
        packing([[a.identifier]]),
        projectCtx(fx),
      ),
    ).rejects.toThrow(/already finished/);
    expect(await db.sprint.count()).toBe(0);
  });

  it('rejects an INVERTED is_blocked_by ordering ACROSS sprints', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await makeItem(fx, { kind: 'subtask', title: 'blocker' });
    const blocked = await makeItem(fx, { kind: 'subtask', title: 'blocked' });
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    await expect(
      aiSprintPlanningService.approveSprintPlan(
        'job_sprint_1',
        // The blocked item is scheduled FIRST — the dependency runs backwards.
        packing([[blocked.identifier], [blocker.identifier]]),
        projectCtx(fx),
      ),
    ).rejects.toThrow(/is_blocked_by order is inverted/);
    expect(await db.sprint.count()).toBe(0);
  });

  it('rejects an inverted ordering WITHIN one sprint — members must be topological', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await makeItem(fx, { kind: 'subtask', title: 'blocker' });
    const blocked = await makeItem(fx, { kind: 'subtask', title: 'blocked' });
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    await expect(
      aiSprintPlanningService.approveSprintPlan(
        'job_sprint_1',
        packing([[blocked.identifier, blocker.identifier]]),
        projectCtx(fx),
      ),
    ).rejects.toThrow(/is_blocked_by order is inverted/);
  });

  it('ACCEPTS a currently-BLOCKED item in a later sprint — the packing is dependency-aware, not ready-only', async () => {
    // The whole point of a multi-sprint packing: work that is blocked TODAY is
    // scheduled AFTER what blocks it. A ready-set-membership check would have
    // rejected this legitimate plan.
    const fx = await makeWorkItemFixture();
    const blocker = await makeItem(fx, { kind: 'subtask', title: 'blocker' });
    const blocked = await makeItem(fx, { kind: 'subtask', title: 'blocked' });
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const result = await aiSprintPlanningService.approveSprintPlan(
      'job_sprint_1',
      packing([[blocker.identifier], [blocked.identifier]]),
      projectCtx(fx),
    );

    expect(result.assigned).toBe(2);
    const rows = await db.sprint.findMany({
      where: { projectId: fx.projectId },
      orderBy: { sequence: 'asc' },
    });
    const item = await db.workItem.findUniqueOrThrow({ where: { id: blocked.id } });
    expect(item.sprintId).toBe(rows[1]!.id);
  });

  it('ignores an is_blocked_by edge pointing OUTSIDE the packing — it constrains no ordering here', async () => {
    const fx = await makeWorkItemFixture();
    const outside = await makeItem(fx, { kind: 'subtask', title: 'not packed' });
    const packed = await makeItem(fx, { kind: 'subtask', title: 'packed' });
    await workItemsService.linkWorkItems(
      { fromId: packed.id, toId: outside.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const result = await aiSprintPlanningService.approveSprintPlan(
      'job_sprint_1',
      packing([[packed.identifier]]),
      projectCtx(fx),
    );
    expect(result.assigned).toBe(1);
  });

  it('rejects a MALFORMED packing at the shape gate, before the semantic pass reads anything', async () => {
    const fx = await makeWorkItemFixture();

    await expect(
      aiSprintPlanningService.approveSprintPlan(
        'job_sprint_1',
        { deltaVersion: 'v2', sprints: [] },
        projectCtx(fx),
      ),
    ).rejects.toBeInstanceOf(SprintAssignmentValidationError);
    expect(await db.sprint.count()).toBe(0);
  });
});

describe('AI sprint planning — atomicity (MOTIR-918)', () => {
  it('rolls the WHOLE approve back when a later sprint fails — no partial plan', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });
    const b = await makeItem(fx, { kind: 'subtask', title: 'B' });

    // Fail the SECOND sprint's assignment, after the first sprint + its
    // membership have already been written inside the transaction.
    const realBulk = (await import('@/lib/services/backlogService')).backlogService
      .bulkAssignToSprint;
    const spy = vi
      .spyOn((await import('@/lib/services/backlogService')).backlogService, 'bulkAssignToSprint')
      .mockImplementationOnce(realBulk)
      .mockImplementationOnce(async () => {
        throw new Error('assignment blew up');
      });

    await expect(
      aiSprintPlanningService.approveSprintPlan(
        'job_sprint_1',
        packing([[a.identifier], [b.identifier]]),
        projectCtx(fx),
      ),
    ).rejects.toThrow('assignment blew up');

    // NOTHING survived — not the first sprint, not its assignment.
    expect(await db.sprint.count({ where: { projectId: fx.projectId } })).toBe(0);
    expect(
      await db.workItem.count({ where: { projectId: fx.projectId, sprintId: { not: null } } }),
    ).toBe(0);
    spy.mockRestore();
  });
});
