import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling MOTIR-918 suite).
// EVERYTHING below it is real: a real Postgres, real work-item rows created
// through the shipped service, and the real `is_blocked_by` edges the captions
// are derived from.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { getJob } from '@/lib/ai/motirAiClient';
import { aiSprintPlanningService } from '@/lib/services/aiSprintPlanningService';
import { SprintAssignmentValidationError } from '@/lib/ai/sprintAssignment';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemFixture } from '../../fixtures';
import type { ProjectContext } from '@/lib/projects';
import type { SprintAssignmentDelta } from '@/lib/ai/types';

// Subtask MOTIR-1750 — the REVIEW read behind the AI sprint-planning UI.
//
// The proposal a `plan_sprint` job returns names work items by KEY only, so the
// review surface needs two facts the browser cannot derive, and both must come
// from the server:
//
//   * each packed key's work item, so a row can render at all;
//   * the `is_blocked_by` edges AMONG the packed items — the per-row "after
//     MOTIR-…" caption. It reuses the SAME repository read the approve path's
//     ordering check uses, so the caption can never disagree with the rule the
//     approve enforces.
//
// What these lock: the resolution itself, the in-packing edge filter (an edge to
// an unpacked item constrains nothing and must not caption a row), that the read
// WRITES NOTHING, that a still-running job and an empty packing are valid
// non-errors rather than failures, and that a malformed result is refused rather
// than half-rendered.

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
});

afterAll(async () => {
  await db.$disconnect();
});

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

const hostStories = new Map<string, string>();

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

/** Create a work item through the SHIPPED service path (it is what resolves the
 *  project's workflow initial status onto the row the review reports). */
async function makeItem(
  fx: WorkItemFixture,
  input: { kind: 'story' | 'task' | 'subtask' | 'bug'; title: string },
): Promise<{ id: string; identifier: string }> {
  const parentId = input.kind === 'subtask' ? await hostStoryId(fx) : undefined;
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

/** Stub the job the review reads back. */
function jobReturns(sprintAssignment: unknown, status = 'succeeded'): void {
  vi.mocked(getJob).mockResolvedValue({
    jobId: 'job_sprint_1',
    status,
    result: sprintAssignment === null ? null : { sprintAssignment },
    error: null,
  } as unknown as Awaited<ReturnType<typeof getJob>>);
}

describe('AI sprint-plan review — resolving the packing for render (MOTIR-1750)', () => {
  it('returns the proposal plus every packed key resolved to its work item', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'Cadence trigger fires at threshold' });
    const b = await makeItem(fx, { kind: 'task', title: 'Design the surface' });
    jobReturns(packing([[a.identifier], [b.identifier]]));

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(review.jobStatus).toBe('succeeded');
    expect(review.proposal?.sprints.map((s) => s.itemKeys)).toEqual([
      [a.identifier],
      [b.identifier],
    ]);
    expect(Object.keys(review.items).sort()).toEqual([a.identifier, b.identifier].sort());
    // The row can render: it carries the fields the shipped backlog row binds.
    expect(review.items[a.identifier]!.item).toMatchObject({
      id: a.id,
      identifier: a.identifier,
      title: 'Cadence trigger fires at threshold',
      kind: 'subtask',
    });
    expect(review.items[a.identifier]!.item.status).toBeTruthy();
  });

  it('captions a row with the IN-PACKING blockers that precede it', async () => {
    const fx = await makeWorkItemFixture();
    const blocker = await makeItem(fx, { kind: 'subtask', title: 'design' });
    const blocked = await makeItem(fx, { kind: 'subtask', title: 'ui' });
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    jobReturns(packing([[blocker.identifier, blocked.identifier]]));

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(review.items[blocked.identifier]!.blockedByKeys).toEqual([blocker.identifier]);
    // Absence is the default — the blocker itself is captioned by nothing.
    expect(review.items[blocker.identifier]!.blockedByKeys).toEqual([]);
  });

  it('lists SEVERAL in-packing blockers for one row, in a stable order', async () => {
    const fx = await makeWorkItemFixture();
    const first = await makeItem(fx, { kind: 'subtask', title: 'first' });
    const second = await makeItem(fx, { kind: 'subtask', title: 'second' });
    const last = await makeItem(fx, { kind: 'subtask', title: 'last' });
    for (const blocker of [first, second]) {
      await workItemsService.linkWorkItems(
        { fromId: last.id, toId: blocker.id, kind: 'is_blocked_by' },
        fx.ctx,
      );
    }
    jobReturns(packing([[first.identifier, second.identifier, last.identifier]]));

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(review.items[last.identifier]!.blockedByKeys).toEqual(
      [first.identifier, second.identifier].sort(),
    );
  });

  it('DROPS an edge whose blocker is outside the packing — it orders nothing here', async () => {
    const fx = await makeWorkItemFixture();
    const outside = await makeItem(fx, { kind: 'subtask', title: 'not packed' });
    const packed = await makeItem(fx, { kind: 'subtask', title: 'packed' });
    await workItemsService.linkWorkItems(
      { fromId: packed.id, toId: outside.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    jobReturns(packing([[packed.identifier]]));

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(review.items[packed.identifier]!.blockedByKeys).toEqual([]);
    expect(review.items[outside.identifier]).toBeUndefined();
  });

  it('reads a key that no longer resolves as ABSENT rather than throwing', async () => {
    const fx = await makeWorkItemFixture();
    const live = await makeItem(fx, { kind: 'subtask', title: 'live' });
    jobReturns(packing([[live.identifier, 'GONE-999']]));

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    // The proposal is reported verbatim — the review must not silently shrink
    // what approving would attempt; the approve path is what refuses it.
    expect(review.proposal?.sprints[0]!.itemKeys).toEqual([live.identifier, 'GONE-999']);
    expect(review.items['GONE-999']).toBeUndefined();
    expect(review.items[live.identifier]).toBeDefined();
  });

  it('does not resolve a key belonging to ANOTHER project', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture();
    const foreign = await makeItem(other, { kind: 'subtask', title: 'foreign' });
    jobReturns(packing([[foreign.identifier]]));

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(review.items[foreign.identifier]).toBeUndefined();
  });

  it('WRITES NOTHING — reviewing is a read, no sprint and no assignment', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, { kind: 'subtask', title: 'A' });
    jobReturns(packing([[a.identifier]]));

    await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(await db.sprint.count()).toBe(0);
    expect(await db.workItem.count({ where: { sprintId: { not: null } } })).toBe(0);
  });
});

describe('AI sprint-plan review — the non-error outcomes (MOTIR-1750)', () => {
  it('reports a still-running job as a null proposal, not a failure', async () => {
    const fx = await makeWorkItemFixture();
    jobReturns(null, 'running');

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(review).toEqual({ jobStatus: 'running', proposal: null, items: {} });
  });

  it('reports an EMPTY packing as a valid proposal with no items', async () => {
    const fx = await makeWorkItemFixture();
    jobReturns(packing([]));

    const review = await aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx));

    expect(review.proposal?.sprints).toEqual([]);
    expect(review.items).toEqual({});
  });

  it('refuses a MALFORMED result rather than half-rendering it', async () => {
    const fx = await makeWorkItemFixture();
    jobReturns({ deltaVersion: 'v2', sprints: [] });

    await expect(
      aiSprintPlanningService.reviewSprintPlan('job_sprint_1', projectCtx(fx)),
    ).rejects.toBeInstanceOf(SprintAssignmentValidationError);
  });
});
