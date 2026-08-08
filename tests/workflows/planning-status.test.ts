import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// THE `planning` STATUS (MOTIR-2425).
//
// When an agent finds a card it cannot implement it submits a re-plan, and the
// card must stop being handed out until a human has acted on that plan.
//
// `blocked` cannot express that, and the reason is structural rather than
// stylistic: readiness here is derived from the `is_blocked_by` EDGES, never
// from the status, so a card at `blocked` is still ready and gets re-dispatched
// on the next run. (MOTIR-1762 is the live proof — status `blocked`, twelve
// blockers all done, `readiness.ready: true`.) Setting it and walking away is a
// status that lies and changes nothing.
//
// `planning` sits in the **in_progress** category instead, so a card there
// leaves the pickable set because the run takes the TO DO category and nothing
// special-cases anything.
//
// ⚠️ THE TEST THAT MATTERS is "a card at `planning` is ABSENT from the ready
// set". Asserting its category would only restate the setup; only the absence
// fails if the pickable rule is wrong somewhere else. Everything below the
// first describe is supporting evidence for that one claim.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260807220000_add_planning_default_status/migration.sql',
);

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Every statement of the backfill migration, run the way `migrate deploy` runs it. */
async function runBackfill(): Promise<void> {
  await db.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

async function readySetKeys(): Promise<string[]> {
  const page = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
  // ⚠️ `key`, not `identifier` — a ready ROW names the item by its `PROD-<n>`
  // key (ADR §7), while `createWorkItem` returns a work-item DTO that calls the
  // same string `identifier`. The two vocabularies meet here.
  return page.items.map((row) => row.key);
}

describe('a card being re-planned leaves the pickable set', () => {
  it('is ABSENT from the ready set once it is at `planning`', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Not implementable as written' },
      fx.ctx,
    );

    // It starts ready — otherwise the absence below proves nothing.
    expect(await readySetKeys()).toContain(item.identifier);

    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'planning', fx.ctx);

    expect(await readySetKeys()).not.toContain(item.identifier);
  });

  it('and `blocked` does NOT do this job — the contrast the card exists for', async () => {
    // Not a curiosity: this is why `planning` had to be added rather than
    // reused. A card at `blocked` with no open blockers is STILL READY, so an
    // agent that set `blocked` and walked away would meet the same card on the
    // next run.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Marked blocked by a human' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'blocked', fx.ctx);

    expect(await readySetKeys()).toContain(item.identifier);
  });

  it('comes BACK to the ready set when a human sends it to `todo`', async () => {
    // The exit matters as much as the entrance: a status with a vague way out
    // accumulates cards nobody owns.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Corrected after the re-plan' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'planning', fx.ctx);
    expect(await readySetKeys()).not.toContain(item.identifier);

    await workItemsService.updateStatus(item.id, 'todo', fx.ctx);
    expect(await readySetKeys()).toContain(item.identifier);
  });
});

describe('the status a fresh project is seeded with', () => {
  it('exists, in the in_progress category, between in_progress and in_review', async () => {
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    const planning = wf.statuses.find((s) => s.key === 'planning');

    expect(planning).toBeDefined();
    expect(planning!.category).toBe('in_progress');
    expect(wf.statuses.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
  });

  it('`blocked` is untouched — same category, same behaviour', async () => {
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    const blocked = wf.statuses.find((s) => s.key === 'blocked');
    expect(blocked?.category).toBe('todo');
  });
});

describe('the transitions in and out are legal without an admin editing anything', () => {
  it.each([
    ['todo', 'planning'],
    ['in_progress', 'planning'],
  ])('%s → %s', async (from, to) => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `into planning from ${from}` },
      fx.ctx,
    );
    if (from !== 'todo') await workItemsService.updateStatus(item.id, from, fx.ctx);
    await expect(workItemsService.updateStatus(item.id, to, fx.ctx)).resolves.toMatchObject({
      status: to,
    });
  });

  it.each(['todo', 'in_progress', 'cancelled'])('planning → %s', async (to) => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `out of planning to ${to}` },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'planning', fx.ctx);
    await expect(workItemsService.updateStatus(item.id, to, fx.ctx)).resolves.toMatchObject({
      status: to,
    });
  });

  it('but NOT in_review → planning — that path goes back through in_progress', async () => {
    // Enumerated, not generated: an edge nobody could justify from a user story
    // does not get added just because it would be convenient.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'in review' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);

    await expect(workItemsService.updateStatus(item.id, 'planning', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});

describe('the backfill onto a project that predates the status', () => {
  /**
   * Strip `planning` from the fixture's project, reproducing a project seeded
   * BEFORE this change.
   *
   * Deleting the status cascades its transitions and its board-column mapping
   * away, which is exactly the pre-migration shape — and is why the assertions
   * below can be about what the migration RESTORED rather than about what it
   * left alone.
   */
  async function stripPlanning(): Promise<void> {
    await db.$executeRawUnsafe(
      `DELETE FROM board_column WHERE project_id = $1 AND name = 'Planning'`,
      fx.projectId,
    );
    await db.$executeRawUnsafe(
      `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'planning'`,
      fx.projectId,
    );
  }

  async function shape(): Promise<{ statuses: number; edges: number; columns: number }> {
    const [status, edges, columns] = await Promise.all([
      db.workflowStatus.count({ where: { projectId: fx.projectId, key: 'planning' } }),
      db.workflowTransition.count({ where: { projectId: fx.projectId } }),
      db.boardColumn.count({ where: { projectId: fx.projectId, name: 'Planning' } }),
    ]);
    return { statuses: status, edges, columns };
  }

  it('adds the status, its five edges and a board column', async () => {
    await stripPlanning();
    const before = await shape();
    expect(before.statuses).toBe(0);
    expect(before.columns).toBe(0);

    await runBackfill();

    const after = await shape();
    expect(after.statuses).toBe(1);
    expect(after.edges).toBe(before.edges + 5);
    expect(after.columns).toBe(1);

    const planning = await db.workflowStatus.findFirst({
      where: { projectId: fx.projectId, key: 'planning' },
    });
    expect(planning?.category).toBe('in_progress');
    // It sorts between in_progress and in_review, as it does in the seed — the
    // position is opaque, the ORDER is the claim.
    const ordered = await db.workflowStatus.findMany({
      where: { projectId: fx.projectId },
      orderBy: { position: 'asc' },
    });
    expect(ordered.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
  });

  it('is IDEMPOTENT — running it twice changes nothing', async () => {
    await stripPlanning();
    await runBackfill();
    const once = await shape();

    await runBackfill();

    expect(await shape()).toEqual(once);
    // …and the mapping did not double either, which a column-only check would
    // miss: two mappings for one status is a board that renders a card twice.
    const mappings = await db.boardColumnStatus.count({
      where: { projectId: fx.projectId, status: { key: 'planning' } },
    });
    expect(mappings).toBe(1);
  });

  it('a card at the BACKFILLED status is absent from the ready set too', async () => {
    // The property this whole card exists for, asserted on a project that got
    // the status from the migration rather than from the seed. The two paths
    // must produce the same thing, and a category typo in the SQL is exactly
    // the kind of divergence that would otherwise ship silently.
    await stripPlanning();
    await runBackfill();

    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'On a backfilled project' },
      fx.ctx,
    );
    expect(await readySetKeys()).toContain(item.identifier);

    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'planning', fx.ctx);

    expect(await readySetKeys()).not.toContain(item.identifier);
  });

  it('leaves a CUSTOM workflow alone — the key join is what scopes it', async () => {
    // A project that renamed `in_progress` no longer matches, and gets nothing.
    // Better than guessing where the status belongs in a workflow somebody
    // designed.
    await stripPlanning();
    await db.$executeRawUnsafe(
      `UPDATE workflow_status SET key = 'doing' WHERE project_id = $1 AND key = 'in_progress'`,
      fx.projectId,
    );

    await runBackfill();

    expect(
      await db.workflowStatus.count({ where: { projectId: fx.projectId, key: 'planning' } }),
    ).toBe(0);
  });
});
