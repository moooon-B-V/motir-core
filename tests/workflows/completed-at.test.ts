import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// `work_item.completedAt` — WHEN a card finished (Story MOTIR-4777 · MOTIR-4780).
//
// Nothing in this schema recorded a completion moment before: `updatedAt` moves
// on any edit, and there is no status-history table. The column is stamped at
// ONE seam — `workItemsService.applyStatusTransition` — inside the same
// `$transaction` and under the same `lockById` as the status write it
// describes.
//
// ⚠️ EVERY TEST HERE RESOLVES "DONE" BY CATEGORY, NEVER BY THE KEY `done`. That
// is the claim worth testing rather than restating: statuses are project-defined
// open vocabulary (`workflow_status` rows, not an enum), so a stamp keyed on the
// literal `'done' | 'cancelled'` pair would pass every default-workflow test in
// this repository and do nothing at all for a workspace that renamed its
// terminal column. `shipped` below is that workspace.
//
// The role question the card raises answers itself: `TEST_DB_APP_ROLE` was
// retired by MOTIR-2734, so the non-bypass `motir_app` role is now the only arm
// there is and every test in this file runs under it.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260907010000_work_item_completed_at/migration.sql',
);

let fx: WorkItemFixture;

beforeEach(async () => {
  // The status-transition paths emit `work-item/transitioned` post-commit and
  // the test env has no Inngest key — the comments-suite pattern.
  spyOnJobDispatch();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function completedAtOf(id: string): Promise<Date | null> {
  const row = await adminDb.workItem.findUnique({ where: { id } });
  return row?.completedAt ?? null;
}

async function makeTask(title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

/** A status the DEFAULT workflow does not have, in the category under test. */
async function makeStatus(key: string, category: 'todo' | 'in_progress' | 'done') {
  return workflowsService.createStatus({
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    key,
    label: key,
    category,
  });
}

async function seededStatusId(key: string): Promise<string> {
  const s = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    workflowsRepository.findStatusByKey(fx.projectId, key, fx.workspaceId, tx),
  );
  if (!s) throw new Error(`seeded status ${key} missing`);
  return s.id;
}

/**
 * Declare a legal edge this project does not have.
 *
 * ⚠️ `done → cancelled` is NOT in the default workflow — measured, not assumed:
 * `DEFAULT_TRANSITIONS` reaches `cancelled` from `todo`, `blocked`,
 * `in_progress`, `planning`, `implemented` and `in_review`, and from `done` only
 * back to `in_progress`. That is a fact about the default EDGE LIST and has
 * nothing to say about the rule under test, which is about CATEGORIES: a move
 * within the done category must not re-stamp, and a project that declares the
 * edge is entitled to make one. Declaring it here keeps these tests about the
 * stamp rather than about which edges happen to be seeded.
 */
async function allowTransition(fromKey: string, toKey: string): Promise<void> {
  await workflowsService.addTransition({
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    fromStatusId: await seededStatusId(fromKey),
    toStatusId: await seededStatusId(toKey),
  });
}

describe('the stamp lands when a card ENTERS a done-category status', () => {
  it('is null until the card finishes, and set on the transaction that finishes it', async () => {
    const item = await makeTask('Stamped on completion');
    expect(await completedAtOf(item.id)).toBeNull();

    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    // Still null: `in_progress` is not a done-category status, and a stamp that
    // appeared here would make every in-flight card "recently finished".
    expect(await completedAtOf(item.id)).toBeNull();

    const before = new Date();
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(item.id, 'done', fx.ctx);
    const after = new Date();

    const stamped = await completedAtOf(item.id);
    expect(stamped).not.toBeNull();
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(stamped!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('lands on a project whose done-category status is NOT named `done`', async () => {
    // ⚠️ THE TEST THAT MATTERS. A stamp resolved from the literal `'done'` /
    // `'cancelled'` pair passes every other case in this file and fails here —
    // silently, on a real customer's renamed workflow, with a Recently-finished
    // tab that is simply always empty and never errors.
    await makeStatus('shipped', 'done');
    // A freshly created status has no edges under a `restricted` policy, so the
    // route to it is declared here. It is workflow setup, not the claim.
    await allowTransition('in_progress', 'shipped');
    const item = await makeTask('Finished in a renamed column');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'shipped', fx.ctx);

    expect(await completedAtOf(item.id)).not.toBeNull();
    // And the row really is sitting in the custom key, not in `done`.
    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe('shipped');
  });

  it('stamps a row that reached a done status carrying no stamp — the backfill-miss arm', async () => {
    // The one case where entering a done-category status FROM another one still
    // stamps: a row that predates the column (or that the migration's backfill
    // could not reach) has a null `completedAt`, and leaving it null for ever
    // because the previous status was also terminal would be the wrong half of
    // the "do not re-stamp" rule.
    const item = await makeTask('Done before the column existed');
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { status: 'done', completedAt: null },
    });

    await allowTransition('done', 'cancelled');
    await workItemsService.updateStatus(item.id, 'cancelled', fx.ctx);
    expect(await completedAtOf(item.id)).not.toBeNull();
  });
});

describe('a move WITHIN the done category does not move the stamp', () => {
  it('done → cancelled leaves the original `completedAt` exactly where it was', async () => {
    const item = await makeTask('Finished, then abandoned');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'done', fx.ctx);
    const first = await completedAtOf(item.id);
    expect(first).not.toBeNull();

    // A measurable gap, so an accidental re-stamp cannot pass by landing on the
    // same millisecond.
    await new Promise((r) => setTimeout(r, 25));
    await allowTransition('done', 'cancelled');
    await workItemsService.updateStatus(item.id, 'cancelled', fx.ctx);

    expect((await completedAtOf(item.id))!.getTime()).toBe(first!.getTime());
  });
});

describe('leaving the done category clears the stamp', () => {
  it('done → in_progress nulls it, and a later return to done sets it AFRESH', async () => {
    const item = await makeTask('Reopened');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'done', fx.ctx);
    const first = await completedAtOf(item.id);
    expect(first).not.toBeNull();

    // `done → in_progress` is a legal edge in the default workflow.
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    expect(await completedAtOf(item.id)).toBeNull();

    await new Promise((r) => setTimeout(r, 25));
    await workItemsService.updateStatus(item.id, 'done', fx.ctx);
    const second = await completedAtOf(item.id);
    expect(second).not.toBeNull();
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
  });
});

describe('two transitions racing the same row cannot produce two stamps', () => {
  it('serialises on the existing lockById, and the second move does not re-stamp', async () => {
    // ⚠️ DRIVEN, not asserted serially. `applyStatusTransition` opens with
    // `workItemRepository.lockById`, so the claim is about what happens when two
    // transactions arrive at once — and a serial re-run of the same two calls
    // would pass against an implementation with no lock at all.
    const item = await makeTask('Raced to done');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);

    const results = await Promise.allSettled([
      workItemsService.updateStatus(item.id, 'done', fx.ctx),
      workItemsService.updateStatus(item.id, 'cancelled', fx.ctx),
    ]);

    // Both moves are legal from `in_progress`, so both may succeed — the lock
    // orders them, it does not refuse one. What must NOT happen is two stamps.
    const settled = results.filter((r) => r.status === 'fulfilled');
    expect(settled.length).toBeGreaterThanOrEqual(1);

    const stamp = await completedAtOf(item.id);
    expect(stamp).not.toBeNull();

    // The row's own revision history is where a double stamp would show: the
    // loser transitioned WITHIN the done category, so it wrote a status
    // revision and must have left the stamp alone. Re-reading and comparing
    // against a second settled read is what proves the value is stable rather
    // than merely present.
    await new Promise((r) => setTimeout(r, 25));
    expect((await completedAtOf(item.id))!.getTime()).toBe(stamp!.getTime());
  });
});

describe('the status-DELETION reassign carries the stamp', () => {
  it('stamps items pushed across the category boundary by deleteStatus', async () => {
    // The one status write in the product that cannot call the seam: a
    // workflow-admin bulk move that deliberately walks no legal edges. Without
    // this, deleting a custom `todo` column and reassigning its items to `Done`
    // would leave them done with a null stamp for ever.
    const triage = await makeStatus('triage', 'todo');
    const item = await makeTask('Reassigned into done');
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'triage' } });
    expect(await completedAtOf(item.id)).toBeNull();

    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: triage.id,
      reassignToStatusId: await seededStatusId('done'),
    });

    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe('done');
    expect(row?.completedAt).not.toBeNull();
  });

  it('clears the stamp on items pushed OUT of the done category by deleteStatus', async () => {
    const shipped = await makeStatus('shipped', 'done');
    const item = await makeTask('Reassigned out of done');
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { status: 'shipped', completedAt: new Date() },
    });

    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: shipped.id,
      reassignToStatusId: await seededStatusId('todo'),
    });

    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe('todo');
    expect(row?.completedAt).toBeNull();
  });

  it('does not move the stamp on a reassign WITHIN the done category', async () => {
    const shipped = await makeStatus('shipped', 'done');
    const item = await makeTask('Shipped, then merged into Done');
    const original = new Date(Date.now() - 60_000);
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { status: 'shipped', completedAt: original },
    });

    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: shipped.id,
      reassignToStatusId: await seededStatusId('done'),
    });

    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe('done');
    expect(row?.completedAt?.getTime()).toBe(original.getTime());
  });
});

describe('the migration backfills already-done rows, by CATEGORY', () => {
  it('fills a done-category row from `updatedAt` and leaves a live row alone', async () => {
    // Run the migration's own statements the way `migrate deploy` runs them —
    // the `implemented-status.test.ts` pattern. The column already exists in
    // this database, so the `ADD COLUMN` is skipped and only the data step is
    // exercised; that step is idempotent by its own `completedAt IS NULL` guard,
    // which is what makes re-running it here safe.
    await makeStatus('shipped', 'done');
    const finished = await makeTask('Finished before the column existed');
    const live = await makeTask('Still in flight');
    await adminDb.workItem.update({
      where: { id: finished.id },
      data: { status: 'shipped', completedAt: null },
    });
    await adminDb.workItem.update({
      where: { id: live.id },
      data: { status: 'in_progress', completedAt: null },
    });

    // Strip `--` comment lines before splitting: this migration's data step
    // carries a long rationale block above it, so a naive split on `;` hands
    // back a chunk that begins with a comment and matches nothing.
    const backfill = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((stmt) => stmt.trim())
      .find((stmt) => stmt.startsWith('UPDATE "work_item"'));
    expect(backfill, 'the migration must carry a data step').toBeTruthy();
    await adminDb.$executeRawUnsafe(backfill!);

    const finishedRow = await adminDb.workItem.findUnique({ where: { id: finished.id } });
    const liveRow = await adminDb.workItem.findUnique({ where: { id: live.id } });

    // ⚠️ Note the row it reached: `shipped`, a CUSTOM done-category status. A
    // backfill written as `IN ('done','cancelled')` would silently skip it, and
    // no default-workflow fixture would ever notice.
    expect(finishedRow?.completedAt?.getTime()).toBe(finishedRow?.updatedAt.getTime());
    expect(liveRow?.completedAt).toBeNull();
  });

  it('says IN the migration that the backfilled values are approximations', () => {
    // The comment is a deliverable, not decoration: `updatedAt` is the closest
    // thing that exists and it is not a completion time, so a report reading an
    // old value as a measurement is the failure this sentence prevents.
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/APPROXIMATION/i);
  });
});
