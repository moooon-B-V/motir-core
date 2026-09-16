import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE MERGE-QUEUE EJECTION's THREE DEFAULT EDGES (MOTIR-5630), story MOTIR-5461.
//
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decision 7: a failure
// removal sends an approved (manual) or in-review (auto) card back to
// `implemented`, and Queue again returns it to `approved` on unchanged heads. New
// projects get the edges from `DEFAULT_TRANSITIONS`; existing ones from
// `20260916180000_add_queue_ejection_default_edges`, which joins on status KEYS
// and adds nothing to a project missing any of the three — that is what leaves a
// CUSTOM workflow alone.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260916180000_add_queue_ejection_default_edges/migration.sql',
);

/** Enumerated here so the test states the graph rather than reading it back
 *  from the thing under test. */
const EJECTION_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['approved', 'implemented'],
  ['in_review', 'implemented'],
  ['implemented', 'approved'],
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

/** The ejection edges a project holds, as `from→to`, one entry per ROW (so a
 *  duplicate would show twice). */
async function ejectionEdges(projectId: string): Promise<string[]> {
  const rows = await adminDb.workflowTransition.findMany({
    where: { projectId },
    include: { fromStatus: true, toStatus: true },
  });
  return rows
    .map((r) => `${r.fromStatus.key}→${r.toStatus.key}`)
    .filter((edge) => EJECTION_EDGES.some(([from, to]) => `${from}→${to}` === edge))
    .sort();
}

/** Delete the given ejection edges from a project — the shape of a project
 *  seeded before MOTIR-5630. */
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

const ALL = EJECTION_EDGES.map(([from, to]) => `${from}→${to}`).sort();

describe('the seed', () => {
  it('a new project carries all three ejection edges, from the constant', async () => {
    const fx = await makeWorkItemFixture();
    expect(await ejectionEdges(fx.projectId)).toEqual(ALL);
    for (const [from, to] of EJECTION_EDGES) {
      expect(DEFAULT_TRANSITIONS.some(([f, t]) => f === from && t === to)).toBe(true);
    }
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

    // A default workflow from before MOTIR-5630: none of the three.
    await strip(standard.projectId, EJECTION_EDGES);
    // A CUSTOM workflow: `implemented` renamed, so the key join cannot find it.
    await strip(renamed.projectId, EJECTION_EDGES);
    await adminDb.workflowStatus.updateMany({
      where: { projectId: renamed.projectId, key: 'implemented' },
      data: { key: 'built' },
    });
    // A project that already holds ONE of the three.
    await strip(partial.projectId, EJECTION_EDGES.slice(1));
  });

  it('adds all three to a default project, none to a renamed one, and only the missing ones to a partial one', async () => {
    expect(await ejectionEdges(standard.projectId)).toEqual([]);
    expect(await ejectionEdges(partial.projectId)).toEqual(['approved→implemented']);

    expect(await runBackfill()).toBe(3 + 0 + 2);

    expect(await ejectionEdges(standard.projectId)).toEqual(ALL);
    expect(await ejectionEdges(renamed.projectId)).toEqual([]);
    // No duplicate of the edge it already had: one row per edge.
    expect(await ejectionEdges(partial.projectId)).toEqual(ALL);
  });

  it('is IDEMPOTENT — a second run inserts zero rows', async () => {
    await runBackfill();
    const once = await Promise.all(
      [standard, renamed, partial].map((fx) => ejectionEdges(fx.projectId)),
    );

    expect(await runBackfill()).toBe(0);

    expect(
      await Promise.all([standard, renamed, partial].map((fx) => ejectionEdges(fx.projectId))),
    ).toEqual(once);
  });

  it('a backfilled project allows the hand moves the edges declare', async () => {
    await runBackfill();
    const item = await workItemsService.createWorkItem(
      { projectId: standard.projectId, kind: 'task', title: 'ejected after approval' },
      standard.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', standard.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', standard.ctx);
    await workItemsService.updateStatus(item.id, 'approved', standard.ctx);

    // `approved → implemented` — the story's own verification recipe, by hand.
    await expect(
      workItemsService.updateStatus(item.id, 'implemented', standard.ctx),
    ).resolves.toMatchObject({ status: 'implemented' });
  });
});
