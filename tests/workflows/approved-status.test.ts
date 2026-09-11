import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_STATUSES, DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE `approved` STATUS (MOTIR-5139), story MOTIR-4905.
//
// A person's YES is a state the product could not express. An approved card
// either sat at `in_review` — which reads as NOBODY HAS LOOKED AT IT — or jumped
// to `done`, which claims it merged. Both are false, and GitHub models the same
// split: a pull request is approved, and separately merged.
//
// ⚠️ THE TEST THAT MATTERS is `implemented → approved` being REFUSED. Under this
// project's `restricted` policy an undeclared hop is a 422, and this is the one
// that would let CI be skipped: `implemented` means the branch is pushed and
// NOTHING has been compiled. CI speaks before a person does, so the only way in
// is through `in_review`, which is the status CI itself writes on green. An edge
// list is a thing you add to; the absence is the thing that has to be asserted,
// because nothing else fails when it stops being true.
//
// ⚠️ SCOPE — this card creates the STATE and moves nothing into it. The parent
// ROLLUP that must not complete on `approved` children, and the DEPENDENT that
// must stay blocked, are MOTIR-5142's integration gate. What is asserted here is
// the category's own structural consequence on THIS card's deliverable: a card
// at `approved` is not pickable, which is the same claim
// `implemented-status.test.ts` and `planning-status.test.ts` make one rung back.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260911140000_add_approved_default_status/migration.sql',
);

/** The four edges `DEFAULT_TRANSITIONS` gains — enumerated here so the test
 *  states the graph rather than deriving it from the thing under test. */
const EDGES_IN: ReadonlyArray<string> = ['in_review'];
const EDGES_OUT: ReadonlyArray<string> = ['done', 'in_progress', 'cancelled'];

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every statement of the backfill migration, run the way `migrate deploy` runs it. */
async function runBackfill(): Promise<void> {
  await adminDb.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

async function readySetKeys(): Promise<string[]> {
  const page = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
  return page.items.map((row) => row.key);
}

/** Walk a fresh card to `approved` the only legal way: in_progress → in_review. */
async function drive(title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
  return item;
}

describe('the seeded workflow carries the ninth status', () => {
  it('has `approved` in the in_progress category, between in_review and done', async () => {
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    const approved = wf.statuses.find((s) => s.key === 'approved');
    expect(approved).toBeDefined();
    // The category IS the mechanism. Only `done` and `cancelled` are terminal,
    // so an approved card is still OPEN everywhere that partitions by category.
    expect(approved?.category).toBe('in_progress');
    expect(approved?.isInitial).toBe(false);
    expect(approved?.label).toBe('Approved');

    const order = wf.statuses
      .slice()
      .sort((a, b) => (a.position < b.position ? -1 : 1))
      .map((s) => s.key);
    expect(order).toEqual(DEFAULT_STATUSES.map((s) => s.key));
    expect(order.indexOf('approved')).toBe(order.indexOf('in_review') + 1);
    expect(order.indexOf('done')).toBe(order.indexOf('approved') + 1);
    // The eighth column's invariant: this insert is AFTER implemented, so it does
    // not push it off the fold. `design/boards/approved-column.mock.html` panel 1.
    expect(order.indexOf('implemented')).toBe(3);
  });

  it('seeds a board column for it, so its cards land somewhere', async () => {
    // Without a column the status is legal but its cards sit in no column and
    // outside the board total — the exact defect an earlier backfill shipped.
    const column = await adminDb.boardColumn.findFirst({
      where: { projectId: fx.projectId, name: 'Approved' },
      include: { statusMappings: { include: { status: true } } },
    });
    expect(column).not.toBeNull();
    expect(column?.statusMappings.map((m) => m.status.key)).toEqual(['approved']);
  });

  it('is a PROTECTED default — it is in DEFAULT_STATUS_KEYS', () => {
    // The protection GATE is already asserted for every default key by
    // `management.test.ts` / `restore-defaults.test.ts`; what this card has to
    // get right is membership, and that derives from STATUS_ORDER rather than
    // from a second hand-edited list. Asserting the derivation is the useful
    // half — a status added to the order but not protected is the failure this
    // catches, and it cannot happen while the set is mapped from the order.
    expect(DEFAULT_STATUS_KEYS.has('approved')).toBe(true);
    expect(DEFAULT_STATUS_KEYS.size).toBe(DEFAULT_STATUSES.length);
  });
});

describe('a card a person approved has not shipped', () => {
  it('is ABSENT from the ready set once it is at `approved`', async () => {
    const item = await drive('Approved, not merged');
    expect(await readySetKeys()).not.toContain(item.identifier);
    await workItemsService.updateStatus(item.id, 'approved', fx.ctx);
    expect(await readySetKeys()).not.toContain(item.identifier);
  });

  it('and `approved` is NOT in the done category — the whole claim of the story', async () => {
    // Asserted against the project's own category set rather than the constant,
    // because the constant is the thing under test. A category typo here is
    // silent: the board renders, the migration applies, and every parent
    // completes early.
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    const terminal = wf.statuses
      .filter((s) => s.category === 'done')
      .map((s) => s.key)
      .sort();
    expect(terminal).toEqual(['cancelled', 'done']);
  });
});

describe('the transitions in and out are legal without an admin editing anything', () => {
  it.each(EDGES_IN)('%s → approved', async (from) => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `into approved from ${from}` },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    if (from !== 'in_progress') await workItemsService.updateStatus(item.id, from, fx.ctx);
    await expect(workItemsService.updateStatus(item.id, 'approved', fx.ctx)).resolves.toMatchObject(
      { status: 'approved' },
    );
  });

  it.each(EDGES_OUT)('approved → %s', async (to) => {
    const item = await drive(`out of approved to ${to}`);
    await workItemsService.updateStatus(item.id, 'approved', fx.ctx);
    await expect(workItemsService.updateStatus(item.id, to, fx.ctx)).resolves.toMatchObject({
      status: to,
    });
  });

  it('⚠️ but NOT implemented → approved — CI speaks before a person does', async () => {
    // THE assertion this card exists to make. `implemented` means the branch is
    // pushed and nothing has been compiled; allowing this hop would let a person
    // approve past a build that never ran.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'built, unchecked' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', fx.ctx);
    await expect(workItemsService.updateStatus(item.id, 'approved', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it('and NOT todo → approved — nobody approves work nobody started', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'never started' },
      fx.ctx,
    );
    await expect(workItemsService.updateStatus(item.id, 'approved', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});

describe('the backfill onto a project that predates the status', () => {
  /**
   * Strip `approved` from the fixture's project, reproducing a project seeded
   * BEFORE this change. Deleting the status cascades its transitions and its
   * board-column mapping away, which is exactly the pre-migration shape.
   */
  async function stripApproved(): Promise<void> {
    await adminDb.$executeRawUnsafe(
      `DELETE FROM board_column WHERE project_id = $1 AND name = 'Approved'`,
      fx.projectId,
    );
    await adminDb.$executeRawUnsafe(
      `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'approved'`,
      fx.projectId,
    );
  }

  async function shape(): Promise<{ statuses: number; edges: number; columns: number }> {
    const [statuses, edges, columns] = await Promise.all([
      adminDb.workflowStatus.count({ where: { projectId: fx.projectId, key: 'approved' } }),
      adminDb.workflowTransition.count({ where: { projectId: fx.projectId } }),
      adminDb.boardColumn.count({ where: { projectId: fx.projectId, name: 'Approved' } }),
    ]);
    return { statuses, edges, columns };
  }

  it('adds the status, its four edges and a board column', async () => {
    await stripApproved();
    const before = await shape();
    expect(before.statuses).toBe(0);
    expect(before.columns).toBe(0);

    await runBackfill();

    const after = await shape();
    expect(after.statuses).toBe(1);
    expect(after.edges).toBe(before.edges + EDGES_IN.length + EDGES_OUT.length);
    expect(after.columns).toBe(1);

    const approved = await adminDb.workflowStatus.findFirst({
      where: { projectId: fx.projectId, key: 'approved' },
    });
    expect(approved?.category).toBe('in_progress');
    expect(approved?.isInitial).toBe(false);
    // The position is opaque; the ORDER is the claim, and the claim is that
    // `in_review.position || 'F'` sorts strictly between in_review and done.
    const ordered = await adminDb.workflowStatus.findMany({
      where: { projectId: fx.projectId },
      orderBy: { position: 'asc' },
    });
    expect(ordered.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
  });

  it('wires exactly the four edges, not three and not five', async () => {
    await stripApproved();
    await runBackfill();

    const rows = await adminDb.workflowTransition.findMany({
      where: { projectId: fx.projectId },
      include: { fromStatus: true, toStatus: true },
    });
    const touching = rows
      .filter((r) => r.fromStatus.key === 'approved' || r.toStatus.key === 'approved')
      .map((r) => `${r.fromStatus.key}→${r.toStatus.key}`)
      .sort();
    expect(touching).toEqual(
      [
        ...EDGES_IN.map((from) => `${from}→approved`),
        ...EDGES_OUT.map((to) => `approved→${to}`),
      ].sort(),
    );
    // And the hop the record refuses is absent from the BACKFILLED project too —
    // the SQL states the same graph the constant does, so a divergence between
    // them is a defect this asserts rather than a comment that claims it.
    expect(touching).not.toContain('implemented→approved');
  });

  it('is IDEMPOTENT — running it twice changes nothing', async () => {
    await stripApproved();
    await runBackfill();
    const once = await shape();

    await runBackfill();

    expect(await shape()).toEqual(once);
    // …and the mapping did not double either, which a column-only check would
    // miss: two mappings for one status is a board that renders a card twice.
    const mappings = await adminDb.boardColumnStatus.count({
      where: { projectId: fx.projectId, status: { key: 'approved' } },
    });
    expect(mappings).toBe(1);
  });

  it('a card at the BACKFILLED status is absent from the ready set too', async () => {
    // The property this card exists for, asserted on a project that got the
    // status from the migration rather than from the seed. A category typo in the
    // SQL is exactly the kind of divergence that would otherwise ship silently.
    await stripApproved();
    await runBackfill();

    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'On a backfilled project' },
      fx.ctx,
    );
    expect(await readySetKeys()).toContain(item.identifier);

    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await workItemsService.updateStatus(item.id, 'approved', fx.ctx);

    expect(await readySetKeys()).not.toContain(item.identifier);
  });

  it('leaves a CUSTOM workflow alone — the key join is what scopes it', async () => {
    // A project that renamed `in_review` no longer matches, and gets nothing.
    // Better than guessing where the status belongs in a workflow somebody
    // designed. This is the SECOND of the two project shapes the card asks for;
    // the default-shaped one is every test above.
    await stripApproved();
    await adminDb.$executeRawUnsafe(
      `UPDATE workflow_status SET key = 'review' WHERE project_id = $1 AND key = 'in_review'`,
      fx.projectId,
    );

    await runBackfill();

    expect(
      await adminDb.workflowStatus.count({ where: { projectId: fx.projectId, key: 'approved' } }),
    ).toBe(0);
    expect(
      await adminDb.boardColumn.count({ where: { projectId: fx.projectId, name: 'Approved' } }),
    ).toBe(0);
  });

  it('leaves a project whose in_review was REMOVED alone as well', async () => {
    // The other way a workflow stops being default: the anchor is gone rather
    // than renamed. The join finds no row, so nothing is written — and nothing
    // throws, which is the part worth asserting.
    await stripApproved();
    await adminDb.$executeRawUnsafe(
      `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'in_review'`,
      fx.projectId,
    );

    await expect(runBackfill()).resolves.not.toThrow();

    expect(
      await adminDb.workflowStatus.count({ where: { projectId: fx.projectId, key: 'approved' } }),
    ).toBe(0);
  });

  it('MOVES NO CARD — it adds a state, it does not put anything in it', async () => {
    // The card's last acceptance criterion, and the one a data migration is most
    // able to break by accident.
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Left alone at todo' },
      fx.ctx,
    );
    const b = await drive('Left alone in review');

    await stripApproved();
    await runBackfill();

    const rows = await adminDb.workItem.findMany({
      where: { id: { in: [a.id, b.id] } },
      orderBy: { key: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['todo', 'in_review']);
  });
});
