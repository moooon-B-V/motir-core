import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6575 · MOTIR-6677 — the reads behind the obsolescence BADGE, against
// a REAL Postgres: the board card, the `/items` List row and each lazily-loaded
// Tree level carry `obsolescence`, and a mark changes NO membership and NO order.
//
// ⚠️ Setting a mark TOUCHES the card (`updatedAt`), and the board's terminal
// columns order by recency, so a card just marked legitimately rises to the top
// of its done column. That is the touch, not the mark. To isolate the mark, each
// comparison restores every row's `updatedAt` to the value it had before the
// mark was set, and then asserts the reads are identical but for the field.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A finished story with one finished child, plus two finished siblings. */
async function seed() {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The v1 importer' },
    fx.ctx,
  );
  const child = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Parse v1 rows' },
    fx.ctx,
  );
  const sibling = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'The v2 importer' },
    fx.ctx,
  );
  const third = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'A loose task' },
    fx.ctx,
  );
  const ids = [story.id, child.id, sibling.id, third.id];
  await adminDb.workItem.updateMany({ where: { id: { in: ids } }, data: { status: 'done' } });
  // Distinct, recent recency so the done column has a real order to keep.
  for (const [i, id] of ids.entries()) {
    await adminDb.workItem.update({
      where: { id },
      data: { updatedAt: new Date(Date.now() - (i + 1) * 60_000) },
    });
  }
  return { story, child, sibling, third, ids };
}

async function mark(ids: string[], marks: Record<string, WorkItemObsolescenceDto>) {
  const before = await adminDb.workItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, updatedAt: true },
  });
  for (const [id, m] of Object.entries(marks)) {
    await workItemsService.updateWorkItem(id, { obsolescence: m }, fx.ctx);
  }
  // Put the touch back — see the header.
  for (const row of before) {
    await adminDb.workItem.update({ where: { id: row.id }, data: { updatedAt: row.updatedAt } });
  }
}

async function boardCards() {
  const board = await boardsService.getBoard(fx.projectId, fx.ctx);
  return board.columns.flatMap((c) =>
    c.cards.map((card) => ({ id: card.id, col: c.id, obsolescence: card.obsolescence })),
  );
}

async function listRows() {
  const page = await workItemsService.getProjectIssuesList(
    fx.projectId,
    { sort: { column: 'status', direction: 'asc' } },
    fx.ctx,
  );
  return page.items.map((r) => ({ id: r.id, obsolescence: r.obsolescence }));
}

async function treeLevel(parentId: string | null) {
  const level = parentId
    ? await workItemsService.listChildIssues(
        parentId,
        { sort: { column: 'key', direction: 'asc' } },
        fx.ctx,
      )
    : await workItemsService.listRootIssues(
        fx.projectId,
        { sort: { column: 'key', direction: 'asc' } },
        fx.ctx,
      );
  return level.rows
    .filter((r): r is Extract<typeof r, { obsolescence: unknown }> => 'obsolescence' in r)
    .map((r) => ({ id: r.id, obsolescence: r.obsolescence }));
}

const strip = <T extends { obsolescence: unknown }>(rows: T[]) =>
  rows.map(({ obsolescence: _omit, ...rest }) => rest);

describe('the reads behind the obsolescence badge (MOTIR-6677)', () => {
  it(
    'the board card carries the mark; the same cards sit in the same columns in the same order',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { story, sibling, ids } = await seed();
      const before = await boardCards();
      expect(before.every((c) => c.obsolescence === null)).toBe(true);
      expect(before.map((c) => c.id)).toEqual(expect.arrayContaining(ids));

      await mark(ids, { [story.id]: 'outdated', [sibling.id]: 'deprecated' });
      const after = await boardCards();

      expect(strip(after)).toEqual(strip(before));
      expect(after.find((c) => c.id === story.id)?.obsolescence).toBe('outdated');
      expect(after.find((c) => c.id === sibling.id)?.obsolescence).toBe('deprecated');
      expect(after.filter((c) => c.obsolescence === null)).toHaveLength(after.length - 2);
    },
  );

  it(
    'the /items List row carries the mark; the same rows come back in the same order',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { story, ids } = await seed();
      const before = await listRows();
      expect(before.map((r) => r.id)).toEqual(expect.arrayContaining(ids));
      await mark(ids, { [story.id]: 'deprecated' });
      const after = await listRows();

      expect(strip(after)).toEqual(strip(before));
      expect(after.find((r) => r.id === story.id)?.obsolescence).toBe('deprecated');
    },
  );

  it(
    'the Tree root AND a lazily-loaded level carry the mark, in the same order',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { story, child, ids } = await seed();
      const rootBefore = await treeLevel(null);
      const levelBefore = await treeLevel(story.id);
      expect(rootBefore.map((r) => r.id)).toContain(story.id);
      expect(levelBefore.map((r) => r.id)).toEqual([child.id]);

      await mark(ids, { [story.id]: 'outdated', [child.id]: 'deprecated' });
      const rootAfter = await treeLevel(null);
      const levelAfter = await treeLevel(story.id);

      expect(strip(rootAfter)).toEqual(strip(rootBefore));
      expect(strip(levelAfter)).toEqual(strip(levelBefore));
      expect(rootAfter.find((r) => r.id === story.id)?.obsolescence).toBe('outdated');
      expect(levelAfter).toEqual([{ id: child.id, obsolescence: 'deprecated' }]);
    },
  );
});

// MOTIR-6678 — the builder's Obsolescence row on a BOARD narrows the board's own
// cards (the list's result sets are `tests/filters/obsolescenceFilter.test.ts`).
describe('the Obsolescence condition narrows the board (MOTIR-6678)', () => {
  it.each([
    ['is_any_of', ['outdated'], ['story']],
    ['is_none_of', ['outdated'], ['child', 'sibling', 'third']],
    ['is_empty', null, ['child', 'third']],
    ['is_not_empty', null, ['story', 'sibling']],
  ] as const)(
    '%s returns exactly its cards',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (operator, value, expected) => {
      const seeded = await seed();
      await mark(seeded.ids, {
        [seeded.story.id]: 'outdated',
        [seeded.sibling.id]: 'deprecated',
      });
      const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
        ast: {
          combinator: 'and',
          conditions: [
            {
              field: 'obsolescence',
              operator,
              value: value ? [...value] : null,
            },
          ],
        },
      });
      const got = board.columns.flatMap((c) => c.cards.map((card) => card.id)).sort();
      const want = expected.map((k) => seeded[k].id).sort();
      expect(got).toEqual(want);
    },
  );
});
