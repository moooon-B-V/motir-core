import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalTransitionError } from '@/lib/workItems/errors';
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
//
// ⚠️ AMENDED BY MOTIR-5804 (§4 FOURTH AMENDMENT, point 6): `implemented → approved`
// is REMOVED from the constant and `approved → in_review` DECLARED, by
// `20260919200000_reask_ejection_default_edges`. The 5630 backfill tests below
// still run THAT historical file as it ships (a migration is never edited); the
// seed and the new migration are asserted against the set as it now stands.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260916180000_add_queue_ejection_default_edges/migration.sql',
);

/** Enumerated here so the test states the graph rather than reading it back
 *  from the thing under test. These are the three MOTIR-5630's backfill WROTE. */
const EJECTION_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['approved', 'implemented'],
  ['in_review', 'implemented'],
  ['implemented', 'approved'],
];

/** The ejection edges as they stand after MOTIR-5804. */
const CURRENT_EJECTION_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['approved', 'in_review'],
  ['approved', 'implemented'],
  ['in_review', 'implemented'],
];

const REASK_MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260919200000_reask_ejection_default_edges/migration.sql',
);

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
async function ejectionEdges(
  projectId: string,
  set: ReadonlyArray<readonly [string, string]> = EJECTION_EDGES,
): Promise<string[]> {
  const rows = await adminDb.workflowTransition.findMany({
    where: { projectId },
    include: { fromStatus: true, toStatus: true },
  });
  return rows
    .map((r) => `${r.fromStatus.key}→${r.toStatus.key}`)
    .filter((edge) => set.some(([from, to]) => `${from}→${to}` === edge))
    .sort();
}

/** Every ejection edge either set names — the whole population both migrations touch. */
const BOTH = [...EJECTION_EDGES, ...CURRENT_EJECTION_EDGES];

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
  it('a new project carries the CURRENT ejection edges from the constant, and no `implemented → approved` (MOTIR-5804)', async () => {
    const fx = await makeWorkItemFixture();
    expect(await ejectionEdges(fx.projectId, BOTH)).toEqual(
      CURRENT_EJECTION_EDGES.map(([from, to]) => `${from}→${to}`).sort(),
    );
    for (const [from, to] of CURRENT_EJECTION_EDGES) {
      expect(DEFAULT_TRANSITIONS.some(([f, t]) => f === from && t === to)).toBe(true);
    }
    expect(DEFAULT_TRANSITIONS.some(([f, t]) => f === 'implemented' && t === 'approved')).toBe(
      false,
    );
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

// ── MOTIR-5804 — the re-ask migration, on real Postgres ──────────────────────
describe('the re-ask migration (MOTIR-5804) onto projects that predate it', () => {
  /** The migration is TWO statements; `$executeRawUnsafe` runs one, so split them. */
  async function runReaskStatements(): Promise<{ inserted: number; deleted: number }> {
    const sql = readFileSync(REASK_MIGRATION, 'utf8');
    const at = sql.indexOf('DELETE FROM');
    const inserted = await adminDb.$executeRawUnsafe(sql.slice(0, at).replace(/-- 2 ·.*$/m, ''));
    const deleted = await adminDb.$executeRawUnsafe(sql.slice(at));
    return { inserted, deleted };
  }

  let standard: WorkItemFixture;
  let renamed: WorkItemFixture;
  let already: WorkItemFixture;

  /** The shape MOTIR-5630's backfill left: `implemented → approved` present,
   *  `approved → in_review` absent. */
  async function preRelease(projectId: string): Promise<void> {
    await strip(projectId, [['approved', 'in_review']]);
    const statuses = await adminDb.workflowStatus.findMany({ where: { projectId } });
    const idOf = (key: string) => statuses.find((row) => row.key === key)?.id;
    const from = idOf('implemented');
    const to = idOf('approved');
    if (from && to) {
      await adminDb.workflowTransition.create({
        data: {
          workspaceId: statuses[0]!.workspaceId,
          projectId,
          fromStatusId: from,
          toStatusId: to,
        },
      });
    }
  }

  beforeEach(async () => {
    standard = await makeWorkItemFixture({ name: 'Standard', identifier: 'STD' });
    renamed = await makeWorkItemFixture({ name: 'Renamed', identifier: 'REN' });
    already = await makeWorkItemFixture({ name: 'Already', identifier: 'ALR' });

    // A default workflow as 5630 left it.
    await preRelease(standard.projectId);
    // A CUSTOM workflow: `implemented` renamed, so the key join cannot find it —
    // and it holds `built → approved`, a transition a TEAM chose.
    await preRelease(renamed.projectId);
    await adminDb.workflowStatus.updateMany({
      where: { projectId: renamed.projectId, key: 'implemented' },
      data: { key: 'built' },
    });
    // A project that ALREADY holds `approved → in_review` (and still the old edge).
    await strip(already.projectId, [['implemented', 'approved']]);
    await preRelease(already.projectId);
    const statuses = await adminDb.workflowStatus.findMany({
      where: { projectId: already.projectId },
    });
    const idOf = (key: string) => statuses.find((row) => row.key === key)!.id;
    await adminDb.workflowTransition.create({
      data: {
        workspaceId: statuses[0]!.workspaceId,
        projectId: already.projectId,
        fromStatusId: idOf('approved'),
        toStatusId: idOf('in_review'),
      },
    });
  });

  it('a default project gains `approved → in_review` and loses `implemented → approved`; a renamed one is untouched; one already holding the edge gets no duplicate', async () => {
    const renamedBefore = await adminDb.workflowTransition.findMany({
      where: { projectId: renamed.projectId },
      orderBy: { id: 'asc' },
    });

    expect(await runReaskStatements()).toEqual({ inserted: 1 + 0 + 0, deleted: 1 + 0 + 1 });

    const now = CURRENT_EJECTION_EDGES.map(([from, to]) => `${from}→${to}`).sort();
    expect(await ejectionEdges(standard.projectId, BOTH)).toEqual(now);
    expect(await ejectionEdges(already.projectId, BOTH)).toEqual(now);
    expect(
      await adminDb.workflowTransition.findMany({
        where: { projectId: renamed.projectId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(renamedBefore);
  });

  it('is IDEMPOTENT — a second run inserts and deletes zero rows', async () => {
    await runReaskStatements();
    expect(await runReaskStatements()).toEqual({ inserted: 0, deleted: 0 });
  });

  it('a converged project refuses `implemented → approved` by hand and allows `approved → in_review`', async () => {
    await runReaskStatements();
    const item = await workItemsService.createWorkItem(
      { projectId: standard.projectId, kind: 'task', title: 'ejected after approval' },
      standard.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', standard.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', standard.ctx);
    await workItemsService.updateStatus(item.id, 'approved', standard.ctx);
    await expect(
      workItemsService.updateStatus(item.id, 'in_review', standard.ctx),
    ).resolves.toMatchObject({ status: 'in_review' });

    await workItemsService.updateStatus(item.id, 'implemented', standard.ctx);
    await expect(
      workItemsService.updateStatus(item.id, 'approved', standard.ctx),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});
