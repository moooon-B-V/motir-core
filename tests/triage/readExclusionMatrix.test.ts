import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { boardsService } from '@/lib/services/boardsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// 6.11.8 — the COMPREHENSIVE read-exclusion guard (per docs/decisions/
// triage-model.md §2; the load-bearing correctness guarantee of Story 6.11).
//
// The model: a submission IS a `work_item` carrying a `triagedAt` marker; the
// single `notInTriageSql` / `{ triagedAt: null }` predicate is ANDed into EVERY
// normal read OUTSIDE any user filter (so no filter can opt back in), and the
// triage-queue read is the ONE read that inverts it. `triageQueue.test.ts`
// (6.11.3) smoke-tested the fragment across the tree / list / board / ready /
// search / backlog / picker; THIS file is the exhaustive guard 6.11.8 owes —
// it adds the reads that smoke test omitted (the swimlane lane aggregates, the
// report aggregates, the lazy tree-level + its count, the raw project/child
// reads) and a service-level board read, all in ONE place so the checklist is
// visible: adding a new `work_item` read WITHOUT the exclusion fails here.
//
// The technique is the TWIN: every item is created as a normal/triage PAIR
// IDENTICAL in every column a read keys on (kind, status, assignee, parent),
// differing ONLY by the `triagedAt` marker. So for each read, "the normal twin
// is present ⇒ the triage twin would be too, but for the exclusion" — which is
// exactly the invariant under test. Real Postgres (the standing rule).
//
// The repository reads that MUST carry the exclusion (the checklist this guard
// covers, all in workItemRepository): findProjectForest, findProjectTreeLevel
// (+ countProjectTreeLevel), findProjectIssuesFlat (+ countProjectIssues),
// findColumnCards, findReadyCandidates, quickSearch, findBacklogPage (+
// countBacklog), findByProjectAndKinds, findByProject, findByProjectFiltered,
// findChildren, aggregateBoardLanesBy{Assignee,Priority,Epic}, aggregate-
// Distribution, aggregateCreatedByBucket. findTriageQueue is the sole inverter.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const SORT = { column: 'key', direction: 'asc' } as const;

// A shared token in every title so `quickSearch` matches the whole set.
const PROBE = 'matrixprobe';

async function createItem(
  fx: WorkItemFixture,
  opts: { kind: 'task' | 'bug' | 'epic'; title: string; parentId?: string | null },
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind,
      title: opts.title,
      parentId: opts.parentId ?? null,
      descriptionMd: null,
    },
    fx.ctx,
  );
}

/** Stamp the triage marker directly — the read-exclusion predicate keys ONLY on
 *  `triagedAt`, so a tests-may-write-the-db marker is the faithful probe (the
 *  6.11.4 intake path produces the same column state). */
async function markTriage(id: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { triagedAt: new Date() } });
}

interface Matrix {
  fx: WorkItemFixture;
  status: string;
  epic: string;
  normalRoot: string;
  triagedRoot: string;
  normalChild: string;
  triagedChild: string;
  /** Every NORMAL item id (must appear in the whole-project reads). */
  normalAll: string[];
  /** Every TRIAGE item id (must appear in NONE of the normal reads). */
  triagedAll: string[];
}

/**
 * Build the twin substrate: a parentless normal/triage pair, plus an epic with
 * a normal/triage child pair (so the parent-scoped reads — findChildren, the
 * lazy tree level, the epic swimlane lane — have a triage twin to exclude too).
 * Both twins in a pair share kind/status/assignee/parent; only the marker
 * differs.
 */
async function buildMatrix(): Promise<Matrix> {
  const fx = await makeWorkItemFixture();
  const normalRoot = await createItem(fx, { kind: 'task', title: `${PROBE} root normal` });
  const triagedRoot = await createItem(fx, { kind: 'task', title: `${PROBE} root triaged` });
  const epic = await createItem(fx, { kind: 'epic', title: `${PROBE} epic container` });
  const normalChild = await createItem(fx, {
    kind: 'task',
    title: `${PROBE} child normal`,
    parentId: epic.id,
  });
  const triagedChild = await createItem(fx, {
    kind: 'task',
    title: `${PROBE} child triaged`,
    parentId: epic.id,
  });
  await markTriage(triagedRoot.id);
  await markTriage(triagedChild.id);

  return {
    fx,
    status: normalRoot.status, // the workflow initial status (category todo) — shared by all
    epic: epic.id,
    normalRoot: normalRoot.id,
    triagedRoot: triagedRoot.id,
    normalChild: normalChild.id,
    triagedChild: triagedChild.id,
    normalAll: [epic.id, normalRoot.id, normalChild.id],
    triagedAll: [triagedRoot.id, triagedChild.id],
  };
}

describe('triage read-exclusion — the exhaustive read-set guard (6.11.8)', () => {
  it('every id-returning normal read excludes the triage twin while keeping its normal twin', async () => {
    const m = await buildMatrix();
    const { fx, status } = m;

    // Each entry: the read, the normal twin(s) it MUST surface, and the triage
    // twin(s) it MUST hide. (Whole-project reads see all three normal items;
    // scoped reads see only the in-scope twin.)
    const reads: Array<{ name: string; ids: () => Promise<string[]>; present: string[] }> = [
      {
        name: 'findProjectForest (tree)',
        present: m.normalAll,
        ids: async () =>
          (await workItemRepository.findProjectForest(fx.projectId, fx.workspaceId)).map(
            (r) => r.id,
          ),
      },
      {
        name: 'findProjectTreeLevel — roots',
        present: [m.epic, m.normalRoot],
        ids: async () =>
          (
            await workItemRepository.findProjectTreeLevel(
              fx.projectId,
              fx.workspaceId,
              null,
              SORT,
              {
                take: 100,
                offset: 0,
              },
            )
          ).map((r) => r.id),
      },
      {
        name: 'findProjectTreeLevel — children of the epic',
        present: [m.normalChild],
        ids: async () =>
          (
            await workItemRepository.findProjectTreeLevel(
              fx.projectId,
              fx.workspaceId,
              m.epic,
              SORT,
              { take: 100, offset: 0 },
            )
          ).map((r) => r.id),
      },
      {
        name: 'findChildren (epic subtree)',
        present: [m.normalChild],
        ids: async () => (await workItemRepository.findChildren(m.epic)).map((r) => r.id),
      },
      {
        name: 'findProjectIssuesFlat (list)',
        present: m.normalAll,
        ids: async () =>
          (await workItemRepository.findProjectIssuesFlat(fx.projectId, fx.workspaceId, SORT)).map(
            (r) => r.id,
          ),
      },
      {
        name: 'findColumnCards (board column)',
        present: [m.normalChild, m.normalRoot],
        ids: async () =>
          (
            await workItemRepository.findColumnCards(
              fx.projectId,
              fx.workspaceId,
              [status],
              'position',
              {
                limit: 100,
              },
            )
          ).map((r) => r.id),
      },
      {
        name: 'findReadyCandidates (ready set)',
        // Ready = leaf items (the epic has a child, so it is not a leaf).
        present: [m.normalRoot, m.normalChild],
        ids: async () =>
          (
            await workItemRepository.findReadyCandidates(fx.projectId, fx.workspaceId, {
              limit: 100,
            })
          ).map((r) => r.id),
      },
      {
        name: 'quickSearch (cmd-K / link picker)',
        present: m.normalAll,
        ids: async () =>
          (await workItemRepository.quickSearch(fx.workspaceId, [fx.projectId], PROBE, 100)).map(
            (r) => r.id,
          ),
      },
      {
        name: 'findBacklogPage (backlog)',
        // Backlog = parentless, unsprinted; the child twins are parented, so the
        // root twin is the meaningful one here.
        present: [m.normalRoot],
        ids: async () =>
          (
            await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, { take: 100 })
          ).map((r) => r.id),
      },
      {
        name: 'findByProjectAndKinds (parent picker)',
        present: m.normalAll,
        ids: async () =>
          (
            await workItemRepository.findByProjectAndKinds(
              fx.projectId,
              ['epic', 'story', 'task', 'bug'],
              fx.workspaceId,
            )
          ).map((r) => r.id),
      },
      {
        name: 'findByProject (paged project read)',
        present: m.normalAll,
        ids: async () =>
          (await workItemRepository.findByProject(fx.projectId, { take: 100 })).map((r) => r.id),
      },
      {
        name: 'findByProjectFiltered',
        present: m.normalAll,
        ids: async () =>
          (await workItemRepository.findByProjectFiltered(fx.projectId)).map((r) => r.id),
      },
    ];

    for (const read of reads) {
      const ids = await read.ids();
      for (const triaged of m.triagedAll) {
        expect(ids, `${read.name} must EXCLUDE the triage item ${triaged}`).not.toContain(triaged);
      }
      for (const normal of read.present) {
        expect(ids, `${read.name} must still RETURN the normal item ${normal}`).toContain(normal);
      }
    }
  });

  it('count reads track their list reads — the triage twin never inflates a count', async () => {
    const m = await buildMatrix();
    const { fx } = m;

    // countProjectIssues == the flat list size (3 normal, 0 triage).
    const listLen = (
      await workItemRepository.findProjectIssuesFlat(fx.projectId, fx.workspaceId, SORT)
    ).length;
    expect(await workItemRepository.countProjectIssues(fx.projectId, fx.workspaceId)).toBe(listLen);
    expect(await workItemRepository.countProjectIssues(fx.projectId, fx.workspaceId)).toBe(3);

    // countBacklog == its own page size (both exclude triage identically).
    const backlogLen = (
      await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, { take: 100 })
    ).length;
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId)).toBe(backlogLen);

    // countProjectTreeLevel == its level page size, at both root and child level.
    const rootLevel = (
      await workItemRepository.findProjectTreeLevel(fx.projectId, fx.workspaceId, null, SORT, {
        take: 100,
        offset: 0,
      })
    ).length;
    expect(await workItemRepository.countProjectTreeLevel(fx.projectId, fx.workspaceId, null)).toBe(
      rootLevel,
    );
    expect(
      await workItemRepository.countProjectTreeLevel(fx.projectId, fx.workspaceId, m.epic),
    ).toBe(1); // only the normal child under the epic — the triage twin is excluded
  });

  it('board swimlane lane aggregates exclude triage (assignee / priority / epic)', async () => {
    const m = await buildMatrix();
    const { fx, status } = m;

    // The card set the lanes partition — already triage-excluded.
    const cards = await workItemRepository.findColumnCards(
      fx.projectId,
      fx.workspaceId,
      [status],
      'position',
      { limit: 100 },
    );
    const cardCount = cards.length;
    expect(cardCount).toBeGreaterThan(0);

    const sum = (rows: Array<{ count: number }>) => rows.reduce((n, r) => n + r.count, 0);

    // Assignee + priority lanes partition the SAME card set, so their totals
    // equal the (triage-excluded) card count — never inflated by the triage twin.
    expect(
      sum(
        await workItemRepository.aggregateBoardLanesByAssignee(fx.projectId, fx.workspaceId, [
          status,
        ]),
      ),
    ).toBe(cardCount);
    expect(
      sum(
        await workItemRepository.aggregateBoardLanesByPriority(fx.projectId, fx.workspaceId, [
          status,
        ]),
      ),
    ).toBe(cardCount);

    // The epic lane counts a card under its nearest ancestor epic (and a card
    // that IS an epic counts in its own lane). The cards mapping to OUR epic are
    // the epic's own card plus its direct child card — derived from the (already
    // triage-excluded) card set, so the triage child twin is NOT among them. If
    // the aggregate had missed the exclusion, the triage child would climb to
    // the epic and inflate this count.
    const expectedEpicLane = cards.filter((c) => c.id === m.epic || c.parentId === m.epic).length;
    expect(expectedEpicLane).toBe(2); // the epic card + its one normal child (NOT the triage twin)
    const epicLanes = await workItemRepository.aggregateBoardLanesByEpic(
      fx.projectId,
      fx.workspaceId,
      [status],
    );
    const lane = epicLanes.find((r) => r.epicId === m.epic);
    expect(lane?.count).toBe(expectedEpicLane);
  });

  it('report aggregates exclude triage (distribution / created-by-bucket)', async () => {
    const m = await buildMatrix();
    const { fx } = m;
    const sum = (rows: Array<{ count: number }>) => rows.reduce((n, r) => n + r.count, 0);

    // Distribution over kind: the 3 normal items (1 epic + 2 task), never the 2
    // triage twins.
    const dist = await workItemRepository.aggregateDistribution(fx.projectId, fx.workspaceId, {
      kind: 'column',
      column: 'kind',
    });
    expect(sum(dist)).toBe(3);

    // Created-by-bucket over a window covering "now": all 5 items were created
    // this instant; only the 3 normal ones are counted.
    const window = {
      start: new Date(Date.now() - 24 * 60 * 60 * 1000),
      end: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
    const buckets = await workItemRepository.aggregateCreatedByBucket(
      fx.projectId,
      fx.workspaceId,
      'day',
      window,
    );
    expect(sum(buckets)).toBe(3);
  });

  it('the board projection (service-level read) excludes triage from every column', async () => {
    const m = await buildMatrix();
    const board = await boardsService.getBoard(m.fx.projectId, m.fx.ctx);
    const cardIds = board.columns.flatMap((col) => col.cards.map((c) => c.id));

    for (const triaged of m.triagedAll) {
      expect(cardIds, 'the board projection must exclude triage cards').not.toContain(triaged);
    }
    // The normal task twins still render on the board.
    expect(cardIds).toContain(m.normalRoot);
    expect(cardIds).toContain(m.normalChild);
  });

  it('the triage-queue read is the SOLE inversion — only triage items, never a normal one', async () => {
    const m = await buildMatrix();
    const queueIds = (
      await workItemRepository.findTriageQueue(m.fx.projectId, m.fx.workspaceId, { limit: 100 })
    ).map((r) => r.id);

    expect([...queueIds].sort()).toEqual([...m.triagedAll].sort());
    for (const normal of m.normalAll) {
      expect(queueIds, 'the queue read must exclude planned (normal) items').not.toContain(normal);
    }
  });
});
