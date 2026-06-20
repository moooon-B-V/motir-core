import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { backlogService } from '@/lib/services/backlogService';
import { FilterValidationError } from '@/lib/filters/errors';
import { FILTER_UNASSIGNED_TOKEN, type FilterAst } from '@/lib/filters/ast';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';

// Subtask 8.8.17 — the backlog read accepts the shared FilterAST + quick facets.
// Real Postgres (no mocks), per CLAUDE.md. These prove the data-path contract:
// `findBacklogPage` / `countBacklog` AND the compiled FilterAST into the WHERE
// while PRESERVING the existing `excludeStatusKeys` + `triagedAt` exclusions and
// the `backlogRank` seek order/count, and `backlogService.getBacklog` resolves +
// validates the inbound AST (an invalid filter → a typed `FilterValidationError`
// the route maps to 422). An unfiltered call is byte-identical to today.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Build a FilterAst literal (loosely typed so a test can craft an INVALID one). */
function buildAst(
  combinator: 'and' | 'or',
  conditions: Array<{ field: string; operator: string; value: unknown }>,
): FilterAst {
  return { combinator, conditions } as unknown as FilterAst;
}

/** Rank an item into the backlog through the repository's required-`tx` write. */
async function setRank(itemId: string, rank: string): Promise<void> {
  await db.$transaction((tx) => workItemRepository.setBacklogRank(itemId, rank, tx));
}

type SeedSpec = {
  rank: string;
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
  type?: 'code' | 'design' | 'test';
  status?: string;
  assigned?: boolean;
  triaged?: boolean;
  title?: string;
};

/**
 * Seed a backlog of varied items, each ranked by `backlogRank` so reads are
 * deterministic. `assigned` puts the fixture owner on the item (else unassigned);
 * `type`/`status`/`triaged` are set via a direct update (the sanctioned test
 * cross-layer reach — `createTestWorkItem` only sets kind/title).
 */
async function seedBacklog(
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  specs: SeedSpec[],
): Promise<Record<string, WorkItem>> {
  const out: Record<string, WorkItem> = {};
  for (const s of specs) {
    const item = await createTestWorkItem(fx, { kind: s.kind, title: s.title ?? s.rank });
    await db.workItem.update({
      where: { id: item.id },
      data: {
        type: s.type ?? null,
        status: s.status ?? 'open',
        assigneeId: s.assigned ? fx.ownerId : null,
        triagedAt: s.triaged ? new Date() : null,
      },
    });
    await setRank(item.id, s.rank);
    out[s.rank] = item;
  }
  return out;
}

/** The canonical mixed backlog used by most cases. Ranks a0..a4 in page order. */
async function seedMixed(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>) {
  return seedBacklog(fx, [
    { rank: 'a0', kind: 'task', type: 'code', assigned: true, title: 'Alpha auth' },
    { rank: 'a1', kind: 'bug', type: 'test', assigned: false, title: 'Beta bug' },
    { rank: 'a2', kind: 'story', type: 'design', assigned: true, title: 'Gamma keep' },
    {
      rank: 'a3',
      kind: 'bug',
      type: 'code',
      assigned: false,
      title: 'Delta keep',
      status: 'in_progress',
    },
    { rank: 'a4', kind: 'task', type: 'code', assigned: true, title: 'Epsilon' },
  ]);
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

describe('backlog filtering — repository (findBacklogPage / countBacklog)', () => {
  it('narrows the page AND the count by the KIND facet', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    const filter = {
      ast: buildAst('and', [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }]),
    };

    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter,
    });
    expect(ids(page)).toEqual([items.a1!.id, items.a3!.id]);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], filter)).toBe(2);
  });

  it('narrows by the TYPE facet', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    const filter = {
      ast: buildAst('and', [{ field: 'type', operator: 'is_any_of', value: ['code'] }]),
    };

    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter,
    });
    expect(ids(page)).toEqual([items.a0!.id, items.a3!.id, items.a4!.id]);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], filter)).toBe(3);
  });

  it('narrows by the STATUS facet', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    const filter = {
      ast: buildAst('and', [{ field: 'status', operator: 'is_any_of', value: ['in_progress'] }]),
    };

    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter,
    });
    expect(ids(page)).toEqual([items.a3!.id]);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], filter)).toBe(1);
  });

  it('narrows by the ASSIGNEE facet (assigned and the unassigned token)', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    const assignedFilter = {
      ast: buildAst('and', [{ field: 'assignee', operator: 'is_any_of', value: [fx.ownerId] }]),
    };
    const unassignedFilter = {
      ast: buildAst('and', [
        { field: 'assignee', operator: 'is_any_of', value: [FILTER_UNASSIGNED_TOKEN] },
      ]),
    };

    const assigned = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter: assignedFilter,
    });
    expect(ids(assigned)).toEqual([items.a0!.id, items.a2!.id, items.a4!.id]);
    expect(
      await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], assignedFilter),
    ).toBe(3);

    const unassigned = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter: unassignedFilter,
    });
    expect(ids(unassigned)).toEqual([items.a1!.id, items.a3!.id]);
    expect(
      await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], unassignedFilter),
    ).toBe(2);
  });

  it('narrows by the TEXT facet (title contains)', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    const filter = {
      ast: buildAst('and', [{ field: 'text', operator: 'contains', value: 'keep' }]),
    };

    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter,
    });
    expect(ids(page)).toEqual([items.a2!.id, items.a3!.id]);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], filter)).toBe(2);
  });

  it('narrows by an advanced OR AST (beyond a single facet)', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    // kind=story OR assignee=unassigned → {a2} ∪ {a1, a3} = {a1, a2, a3} in rank order.
    const filter = {
      ast: buildAst('or', [
        { field: 'kind', operator: 'is_any_of', value: ['story'] },
        { field: 'assignee', operator: 'is_any_of', value: [FILTER_UNASSIGNED_TOKEN] },
      ]),
    };

    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter,
    });
    expect(ids(page)).toEqual([items.a1!.id, items.a2!.id, items.a3!.id]);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], filter)).toBe(3);
  });

  it('still honours the excludeStatusKeys + triagedAt exclusions UNDER a filter', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedBacklog(fx, [
      { rank: 'a0', kind: 'bug', title: 'live bug' },
      { rank: 'a1', kind: 'bug', title: 'done bug', status: 'done' },
      { rank: 'a2', kind: 'bug', title: 'triaged bug', triaged: true },
    ]);
    // A kind=bug filter MATCHES all three, but the done-status and triaged items
    // must stay excluded (the backlog's existing read-exclusions hold under it).
    const filter = {
      ast: buildAst('and', [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }]),
    };

    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: ['done'],
      filter,
    });
    expect(ids(page)).toEqual([items.a0!.id]);
    expect(
      await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, ['done'], filter),
    ).toBe(1);
  });

  it('seek-paginates correctly with a filter applied (page 2 continues the filtered set)', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    // type=code matches a0, a3, a4 (in rank order). Walk it one row at a time.
    const filter = {
      ast: buildAst('and', [{ field: 'type', operator: 'is_any_of', value: ['code'] }]),
    };

    const page1 = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 1,
      excludeStatusKeys: [],
      filter,
    });
    // take+1 over-fetch → 2 rows, the second signalling a next page.
    expect(ids(page1)).toEqual([items.a0!.id, items.a3!.id]);

    const page2 = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 1,
      cursor: items.a0!.id,
      excludeStatusKeys: [],
      filter,
    });
    expect(ids(page2)).toEqual([items.a3!.id, items.a4!.id]);

    const page3 = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 1,
      cursor: items.a3!.id,
      excludeStatusKeys: [],
      filter,
    });
    // Last filtered row — no over-fetch row, so no next page.
    expect(ids(page3)).toEqual([items.a4!.id]);
  });

  it('an UNFILTERED call is byte-identical to omitting the filter (regression guard)', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    const all = [items.a0!.id, items.a1!.id, items.a2!.id, items.a3!.id, items.a4!.id];

    const noArg = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
    });
    const undefinedFilter = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter: undefined,
    });
    // An empty-condition AST also takes the unfiltered path (no SQL change).
    const emptyAst = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 50,
      excludeStatusKeys: [],
      filter: { ast: buildAst('and', []) },
    });

    expect(ids(noArg)).toEqual(all);
    expect(ids(undefinedFilter)).toEqual(all);
    expect(ids(emptyAst)).toEqual(all);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [])).toBe(5);
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], undefined)).toBe(
      5,
    );
  });
});

describe('backlog filtering — service (getBacklog resolves + validates)', () => {
  it('resolves a facet AST and returns the filtered page + count', async () => {
    const fx = await makeWorkItemFixture();
    const items = await seedMixed(fx);
    const page = await backlogService.getBacklog(
      fx.projectId,
      { filterAst: buildAst('and', [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }]) },
      fx.ctx,
    );
    expect(page.items.map((i) => i.id)).toEqual([items.a1!.id, items.a3!.id]);
    expect(page.totalCount).toBe(2);
  });

  it('rejects an invalid filter with a typed FilterValidationError (→ 422)', async () => {
    const fx = await makeWorkItemFixture();
    await seedMixed(fx);
    await expect(
      backlogService.getBacklog(
        fx.projectId,
        // a real field with an operator it does not support → UnknownFilterOperatorError
        {
          filterAst: buildAst('and', [
            { field: 'kind', operator: 'not_a_real_operator', value: ['bug'] },
          ]),
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(FilterValidationError);
  });

  it('an unfiltered getBacklog is unchanged (full backlog + count)', async () => {
    const fx = await makeWorkItemFixture();
    await seedMixed(fx);
    const page = await backlogService.getBacklog(fx.projectId, {}, fx.ctx);
    expect(page.items).toHaveLength(5);
    expect(page.totalCount).toBe(5);
  });
});
