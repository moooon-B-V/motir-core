import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PLANNING PARKING EDGES (MOTIR-5643), bug MOTIR-5640.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D10: a plan parks every
// committed target it names from any NON-terminal status, and approving the plan
// rests a still-gated target at `blocked`. Four edges IN (`blocked`,
// `implemented`, `in_review`, `approved` joining the original `todo` and
// `in_progress`) and one OUT (`planning → blocked`).
//
// New projects get them from `DEFAULT_TRANSITIONS`; existing ones from
// `20260920090000_add_planning_parking_edges`, which joins on status KEYS and so
// adds nothing to a project missing an endpoint — that is what leaves a CUSTOM
// workflow alone.
//
// Modelled on `queue-ejection-edges.test.ts`, which is the same shape one
// decision earlier: edges only, no new status, a key-joined backfill.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260920090000_add_planning_parking_edges/migration.sql',
);

/** Enumerated here so the test STATES the graph rather than reading it back from
 *  the thing under test. */
const PARKING_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['blocked', 'planning'],
  ['implemented', 'planning'],
  ['in_review', 'planning'],
  ['approved', 'planning'],
  ['planning', 'blocked'],
];

/** The pair AMENDMENT 16 D2 forbids: we plan FORWARD, so a terminal card is
 *  superseded rather than re-planned in place. */
const FORBIDDEN_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['done', 'planning'],
  ['cancelled', 'planning'],
];

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every statement of the backfill, run the way `migrate deploy` runs it; answers
 *  the rows it inserted. */
async function runBackfill(): Promise<number> {
  return adminDb.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

/** The parking edges a project holds, as `from→to`, one entry per ROW (so a
 *  duplicate would show twice). */
async function parkingEdges(projectId: string): Promise<string[]> {
  const rows = await adminDb.workflowTransition.findMany({
    where: { projectId },
    include: { fromStatus: true, toStatus: true },
  });
  return rows
    .map((r) => `${r.fromStatus.key}→${r.toStatus.key}`)
    .filter((edge) => PARKING_EDGES.some(([from, to]) => `${from}→${to}` === edge))
    .sort();
}

/** Delete the given parking edges from a project — the shape of a project seeded
 *  before MOTIR-5643. */
async function strip(
  projectId: string,
  edges: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  for (const [from, to] of edges) {
    await adminDb.workflowTransition.deleteMany({
      where: { projectId, fromStatus: { key: from }, toStatus: { key: to } },
    });
  }
}

const ALL = PARKING_EDGES.map(([from, to]) => `${from}→${to}`).sort();

describe('the seed', () => {
  it('a new project carries all five parking edges, from the constant', async () => {
    const fx = await makeWorkItemFixture();
    expect(await parkingEdges(fx.projectId)).toEqual(ALL);
    for (const [from, to] of PARKING_EDGES) {
      expect(DEFAULT_TRANSITIONS.some(([f, t]) => f === from && t === to)).toBe(true);
    }
  });

  it('declares NO edge from a terminal status into `planning` (AMENDMENT 16 D2)', async () => {
    for (const [from, to] of FORBIDDEN_EDGES) {
      expect(DEFAULT_TRANSITIONS.some(([f, t]) => f === from && t === to)).toBe(false);
    }

    // …and the seeded project does not hold one either, so the absence is a
    // property of what ships and not only of the constant.
    const fx = await makeWorkItemFixture();
    const rows = await adminDb.workflowTransition.findMany({
      where: {
        projectId: fx.projectId,
        fromStatus: { key: { in: ['done', 'cancelled'] } },
        toStatus: { key: 'planning' },
      },
    });
    expect(rows).toEqual([]);
  });
});

describe('the backfill onto projects that predate the edges', () => {
  let standard: WorkItemFixture;
  let renamed: WorkItemFixture;
  let partial: WorkItemFixture;

  beforeEach(async () => {
    standard = await makeWorkItemFixture({ name: 'Standard', identifier: 'STD' });
    renamed = await makeWorkItemFixture({ name: 'Renamed', identifier: 'REN' });
    partial = await makeWorkItemFixture({ name: 'Partial', identifier: 'PAR' });

    // A default workflow from before MOTIR-5643: none of the five.
    await strip(standard.projectId, PARKING_EDGES);
    // A CUSTOM workflow: `planning` renamed, so the key join cannot find the
    // endpoint that four of the five edges need — and the fifth leaves FROM it.
    await strip(renamed.projectId, PARKING_EDGES);
    await adminDb.workflowStatus.updateMany({
      where: { projectId: renamed.projectId, key: 'planning' },
      data: { key: 'replanning' },
    });
    // A project that already holds ONE of the five.
    await strip(partial.projectId, PARKING_EDGES.slice(1));
  });

  it('adds all five to a default project, none to a renamed one, and only the missing ones to a partial one', async () => {
    expect(await parkingEdges(standard.projectId)).toEqual([]);
    expect(await parkingEdges(partial.projectId)).toEqual(['blocked→planning']);

    expect(await runBackfill()).toBe(5 + 0 + 4);

    expect(await parkingEdges(standard.projectId)).toEqual(ALL);
    expect(await parkingEdges(renamed.projectId)).toEqual([]);
    // No duplicate of the edge it already had: one row per edge.
    expect(await parkingEdges(partial.projectId)).toEqual(ALL);
  });

  it('is IDEMPOTENT — a second run inserts zero rows', async () => {
    await runBackfill();
    const once = await Promise.all(
      [standard, renamed, partial].map((fx) => parkingEdges(fx.projectId)),
    );

    expect(await runBackfill()).toBe(0);

    expect(
      await Promise.all([standard, renamed, partial].map((fx) => parkingEdges(fx.projectId))),
    ).toEqual(once);
  });

  it('never inserts an edge from a terminal status, on any project shape', async () => {
    await runBackfill();
    const rows = await adminDb.workflowTransition.findMany({
      where: {
        fromStatus: { key: { in: ['done', 'cancelled'] } },
        toStatus: { key: 'planning' },
      },
    });
    expect(rows).toEqual([]);
  });

  it('a backfilled project allows the hand moves the edges declare', async () => {
    await runBackfill();
    const item = await workItemsService.createWorkItem(
      { projectId: standard.projectId, kind: 'task', title: 'parked while its plan is rewritten' },
      standard.ctx,
    );

    // `blocked → planning` — a gated card whose plan turns out to be wrong. This
    // is the move that was impossible before MOTIR-5643: `blocked` had no edge
    // into `planning` at all.
    await workItemsService.updateStatus(item.id, 'blocked', standard.ctx);
    await expect(
      workItemsService.updateStatus(item.id, 'planning', standard.ctx),
    ).resolves.toMatchObject({ status: 'planning' });

    // `planning → blocked` — the resting status an approved plan writes when a
    // live `blocked_by` of the parked card is still open (AMENDMENT 16 D6).
    await expect(
      workItemsService.updateStatus(item.id, 'blocked', standard.ctx),
    ).resolves.toMatchObject({ status: 'blocked' });
  });

  it('a backfilled project can be parked from `implemented`, `in_review` and `approved`', async () => {
    await runBackfill();
    for (const from of ['implemented', 'in_review', 'approved'] as const) {
      const item = await workItemsService.createWorkItem(
        { projectId: standard.projectId, kind: 'task', title: `parked from ${from}` },
        standard.ctx,
      );
      await workItemsService.updateStatus(item.id, 'in_progress', standard.ctx);
      if (from === 'implemented') {
        await workItemsService.updateStatus(item.id, 'implemented', standard.ctx);
      } else {
        await workItemsService.updateStatus(item.id, 'in_review', standard.ctx);
        if (from === 'approved') {
          await workItemsService.updateStatus(item.id, 'approved', standard.ctx);
        }
      }

      await expect(
        workItemsService.updateStatus(item.id, 'planning', standard.ctx),
      ).resolves.toMatchObject({ status: 'planning' });
    }
  });
});
