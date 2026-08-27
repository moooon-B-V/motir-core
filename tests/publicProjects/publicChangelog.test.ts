import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Story 8.9 · Subtask 8.9.3 — the public CHANGELOG read model
// (`docs/decisions/public-follow-and-changelog.md`). Real Postgres, no mocks.
//
// The changelog is DERIVED: an entry is a work item that entered a shipped
// status, dated by that transition, read out of the 1.4.6 revision trail. So
// every test here writes revision rows the way the trail carries them
// (`changeKind: 'updated'`, `diff.status = { from, to }`) and then asserts what
// the read makes of them.
//
// Asserted at the PAYLOAD level — what the read SELECTs — not the DOM. The
// privacy guarantees this file covers are "the row never crosses the wire",
// which is a property of the query, and the feed (8.9.6) and the digest (8.9.7)
// compose the SAME service method precisely so that one proof covers all three.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A fixture whose project is PUBLIC — the shortcut the other public tests use. */
async function makePublicProjectFixture(name = 'Acme'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

/**
 * Record ONE status transition on the trail, exactly as `workItemsService`
 * does — and set the item's CURRENT status to match, because the read re-tests
 * it (a `MAX` over into-done transitions is blind to a later move back out).
 *
 * `changedAt` is passed in rather than defaulted so a test can place two ships
 * in a known order, and two in the SAME millisecond to exercise the tiebreak.
 */
async function transition(
  fx: WorkItemFixture,
  workItemId: string,
  from: string | null,
  to: string,
  changedAt: Date,
): Promise<void> {
  await adminDb.workItemRevision.create({
    data: {
      workItemId,
      changedById: fx.ownerId,
      changedAt,
      changeKind: 'updated',
      diff: { status: { from, to } },
    },
  });
  await adminDb.workItem.update({ where: { id: workItemId }, data: { status: to } });
}

const T1 = new Date('2026-08-01T10:00:00.000Z');
const T2 = new Date('2026-08-02T10:00:00.000Z');
const T3 = new Date('2026-08-03T10:00:00.000Z');

describe('the changelog derives its entries from done-transitions', () => {
  it('lists shipped items newest-first, dated by the transition and not by createdAt', async () => {
    const fx = await makePublicProjectFixture();
    const older = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped first' });
    const newer = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped second' });

    // Deliberately inverted against creation order: `older` is created first and
    // ships LAST, so an implementation that sorted by `createdAt` or by `key`
    // would pass a naive test and fail this one.
    await transition(fx, newer.id, 'in_progress', 'done', T1);
    await transition(fx, older.id, 'in_progress', 'done', T2);

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);

    expect(page.entries.map((e) => e.title)).toEqual(['Shipped first', 'Shipped second']);
    expect(page.entries[0]?.shippedAt).toBe(T2.toISOString());
    expect(page.entries[1]?.shippedAt).toBe(T1.toISOString());
    expect(page.nextCursor).toBeNull();
  });

  it('an item that never moved is absent — a row CREATED at a done status writes no revision', async () => {
    const fx = await makePublicProjectFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Imported as closed' });
    // The importer's authoritative set: the status is `done` and the trail is
    // empty. This is what keeps an imported backlog of closed issues from
    // flooding a project's first changelog.
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries).toEqual([]);
  });

  it('dates a re-shipped item by its LATEST ship, not its first', async () => {
    const fx = await makePublicProjectFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped twice' });

    await transition(fx, item.id, 'in_progress', 'done', T1);
    await transition(fx, item.id, 'done', 'in_progress', T2); // reopened
    await transition(fx, item.id, 'in_progress', 'done', T3); // re-shipped

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries).toHaveLength(1);
    // T1 is the FIRST resolution — the date the age report would use, and the
    // one a feed reader has already scrolled past.
    expect(page.entries[0]?.shippedAt).toBe(T3.toISOString());
  });

  it('drops an item that has been REOPENED and not yet re-shipped', async () => {
    const fx = await makePublicProjectFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Back in progress' });

    await transition(fx, item.id, 'in_progress', 'done', T1);
    await transition(fx, item.id, 'done', 'in_progress', T2);

    // The into-done revision is still on the trail; only the CURRENT-status
    // re-test removes the entry, which is the check a MAX() alone cannot make.
    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries).toEqual([]);
  });
});

describe('cancelled is done-category and is NOT shipped', () => {
  it('never publishes a cancelled item, though its status category is `done`', async () => {
    const fx = await makePublicProjectFixture();
    const shipped = await createTestWorkItem(fx, { kind: 'task', title: 'Really shipped' });
    const abandoned = await createTestWorkItem(fx, { kind: 'task', title: 'Abandoned' });

    await transition(fx, shipped.id, 'in_progress', 'done', T1);
    await transition(fx, abandoned.id, 'in_progress', 'cancelled', T2);

    // Guard the premise rather than assume it: if `cancelled` ever stopped being
    // a done-category status this test would still pass while proving nothing.
    const cancelled = await adminDb.workflowStatus.findFirst({
      where: { projectId: fx.projectId, key: 'cancelled' },
    });
    expect(cancelled?.category).toBe('done');

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries.map((e) => e.title)).toEqual(['Really shipped']);
  });

  it('DOES publish an item that shipped after being cancelled', async () => {
    const fx = await makePublicProjectFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Revived' });

    await transition(fx, item.id, 'todo', 'cancelled', T1);
    // `cancelled → done` is a transition between two done-CATEGORY statuses, so
    // a from-side test written as `fs.category <> 'done'` would swallow it and
    // the item would never appear. This is why `cancelled` is not-shipped on the
    // `from` side too.
    await transition(fx, item.id, 'cancelled', 'done', T2);

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries.map((e) => e.title)).toEqual(['Revived']);
    expect(page.entries[0]?.shippedAt).toBe(T2.toISOString());
  });
});

describe('the 6.14 privacy guarantee holds on the changelog', () => {
  it("excludes a private epic's DESCENDANTS from a non-member's changelog", async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Private epic' });
    const child = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Hidden story',
      parentId: epic.id,
    });
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'Public task' });
    await adminDb.workItem.update({
      where: { id: epic.id },
      data: { publicChildrenHidden: true },
    });

    await transition(fx, child.id, 'in_progress', 'done', T1);
    await transition(fx, open.id, 'in_progress', 'done', T2);

    const anonymous = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(anonymous.entries.map((e) => e.title)).toEqual(['Public task']);

    // A MEMBER reads the unfiltered stream — the same rule the rest of the
    // public projection follows.
    const member = await publicProjectsService.getChangelog(fx.projectIdentifier, fx.ownerId);
    expect(member.entries.map((e) => e.title)).toEqual(['Public task', 'Hidden story']);
  });

  it("excludes a private epic's OWN ROW — the predicate 6.14's helper does not supply", async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Secret programme' });
    await adminDb.workItem.update({
      where: { id: epic.id },
      data: { publicChildrenHidden: true },
    });
    await transition(fx, epic.id, 'in_progress', 'done', T1);

    // The exclusion SET genuinely does not contain it — the epic row is the
    // visible "this epic is not public" placeholder in the TREE, deliberately.
    const hidden = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findPublicHiddenDescendantIds(fx.projectId, fx.workspaceId, tx),
    );
    expect(hidden).not.toContain(epic.id);

    // A stream has no placeholder entry, so the row must still be absent — and
    // its TITLE is the one field 6.14 leaves visible, which is exactly what a
    // feed would have carried away permanently.
    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries).toEqual([]);
  });

  it('excludes archived and triage items', async () => {
    const fx = await makePublicProjectFixture();
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'Archived' });
    const triaged = await createTestWorkItem(fx, { kind: 'task', title: 'A public request' });
    const normal = await createTestWorkItem(fx, { kind: 'task', title: 'Normal' });

    await transition(fx, archived.id, 'in_progress', 'done', T1);
    await transition(fx, triaged.id, 'in_progress', 'done', T2);
    await transition(fx, normal.id, 'in_progress', 'done', T3);
    await adminDb.workItem.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });
    await adminDb.workItem.update({ where: { id: triaged.id }, data: { triagedAt: new Date() } });

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries.map((e) => e.title)).toEqual(['Normal']);
  });
});

describe('the entry shape', () => {
  it('carries the ancestor epic as a chip, and no internal columns', async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Launch readiness' });
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'A story',
      parentId: epic.id,
    });
    const task = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'A task two levels down',
      parentId: story.id,
    });
    await transition(fx, task.id, 'in_progress', 'done', T1);

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    const entry = page.entries[0];

    // The chip walks UP past the story to the epic — the read's bounded
    // three-join ancestor chain, not just the direct parent.
    expect(entry?.epic).toEqual({ identifier: epic.identifier, title: 'Launch readiness' });
    // The public boundary is structural: the DTO has no field to leak into.
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ['epic', 'identifier', 'key', 'kind', 'priority', 'shippedAt', 'status', 'title'].sort(),
    );
  });

  it('gives an EPIC entry no chip — it would name itself', async () => {
    const fx = await makePublicProjectFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'A whole epic shipped' });
    await transition(fx, epic.id, 'in_progress', 'done', T1);

    const page = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(page.entries[0]?.epic).toBeNull();
  });
});

describe('paging is stable across a millisecond tie', () => {
  it('pages every entry exactly once when two ships share a timestamp', async () => {
    const fx = await makePublicProjectFixture();
    const titles: string[] = [];
    // 25 items > one page of 20, and every one of them ships at the SAME
    // instant — the case where `shippedAt` alone is not a total order and an
    // untiebroken cursor skips or repeats rows.
    for (let i = 0; i < 25; i += 1) {
      const item = await createTestWorkItem(fx, { kind: 'task', title: `Item ${i}` });
      titles.push(`Item ${i}`);
      await transition(fx, item.id, 'in_progress', 'done', T1);
    }

    const first = await publicProjectsService.getChangelog(fx.projectIdentifier, null);
    expect(first.entries).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();

    const second = await publicProjectsService.getChangelog(
      fx.projectIdentifier,
      null,
      first.nextCursor ?? undefined,
    );
    expect(second.entries).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.entries, ...second.entries].map((e) => e.title);
    expect(new Set(seen).size).toBe(25);
    expect(new Set(seen)).toEqual(new Set(titles));
  });
});
