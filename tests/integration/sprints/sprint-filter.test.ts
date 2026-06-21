import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { backlogService } from '@/lib/services/backlogService';
import { FilterValidationError } from '@/lib/filters/errors';
import { FILTER_UNASSIGNED_TOKEN, type FilterAst } from '@/lib/filters/ast';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';

// Subtask 8.8.20 — the SPRINT-issues read accepts the same shared FilterAST +
// quick facets the backlog read got in 8.8.17, so a filtered backlog re-projects
// its sprint containers too (the 8.8.16 design, MOTIR-1200). Real Postgres (no
// mocks), per CLAUDE.md. These prove the data-path contract: `findSprintIssues`
// / `countSprintIssues` AND the compiled FilterAST into the WHERE while
// PRESERVING the `backlogRank` seek order/count, KEEPING the sprint's done +
// in-progress issues (a sprint shows its whole committed set — UNLIKE the
// backlog, which hides done), and `backlogService.getSprintIssues` resolves +
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

/** Set a work item's backlogRank through the repository's required-`tx` write. */
async function setRank(itemId: string, rank: string): Promise<void> {
  await db.$transaction((tx) => workItemRepository.setBacklogRank(itemId, rank, tx));
}

/** A planned sprint row inserted directly (mirrors the sprint repo test). */
async function makeSprint(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>): Promise<string> {
  const row = await db.sprint.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Sprint 1',
      sequence: 1,
      state: 'active',
    },
  });
  return row.id;
}

type SeedSpec = {
  rank: string;
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
  type?: 'code' | 'design' | 'test';
  status?: string;
  assigned?: boolean;
  title?: string;
};

/**
 * Seed a sprint of varied items, each placed INTO the sprint (`sprintId`) and
 * ranked by `backlogRank` so reads are deterministic. `assigned` puts the
 * fixture owner on the item; `type`/`status` are set via a direct update (the
 * sanctioned test cross-layer reach — `createTestWorkItem` only sets kind/title).
 */
async function seedSprint(
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  sprintId: string,
  specs: SeedSpec[],
): Promise<Record<string, WorkItem>> {
  const out: Record<string, WorkItem> = {};
  for (const s of specs) {
    const item = await createTestWorkItem(fx, { kind: s.kind, title: s.title ?? s.rank });
    await db.workItem.update({
      where: { id: item.id },
      data: {
        sprintId,
        type: s.type ?? null,
        status: s.status ?? 'open',
        assigneeId: s.assigned ? fx.ownerId : null,
      },
    });
    await setRank(item.id, s.rank);
    out[s.rank] = item;
  }
  return out;
}

/** The canonical mixed sprint used by most cases. Ranks a0..a4 in page order.
 *  a3 is a DONE bug — a sprint KEEPS it (the backlog would hide it). */
async function seedMixed(fx: Awaited<ReturnType<typeof makeWorkItemFixture>>, sprintId: string) {
  return seedSprint(fx, sprintId, [
    { rank: 'a0', kind: 'task', type: 'code', assigned: true, title: 'Alpha auth' },
    { rank: 'a1', kind: 'bug', type: 'test', assigned: false, title: 'Beta bug' },
    { rank: 'a2', kind: 'story', type: 'design', assigned: true, title: 'Gamma keep' },
    {
      rank: 'a3',
      kind: 'bug',
      type: 'code',
      assigned: false,
      title: 'Delta keep',
      status: 'done',
    },
    { rank: 'a4', kind: 'task', type: 'code', assigned: true, title: 'Epsilon' },
  ]);
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

describe('sprint filtering — repository (findSprintIssues / countSprintIssues)', () => {
  it('narrows the page AND the count by the KIND facet', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    const filter = {
      ast: buildAst('and', [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }]),
    };

    const page = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter,
    });
    // a1 (live bug) + a3 (DONE bug) — the sprint keeps its done issue.
    expect(ids(page)).toEqual([items.a1!.id, items.a3!.id]);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, filter)).toBe(2);
  });

  it('narrows by the TYPE facet', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    const filter = {
      ast: buildAst('and', [{ field: 'type', operator: 'is_any_of', value: ['code'] }]),
    };

    const page = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter,
    });
    expect(ids(page)).toEqual([items.a0!.id, items.a3!.id, items.a4!.id]);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, filter)).toBe(3);
  });

  it('narrows by the STATUS facet — and KEEPS a matching done issue (sprint, not backlog)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    const filter = {
      ast: buildAst('and', [{ field: 'status', operator: 'is_any_of', value: ['done'] }]),
    };

    const page = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter,
    });
    expect(ids(page)).toEqual([items.a3!.id]);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, filter)).toBe(1);
  });

  it('narrows by the ASSIGNEE facet (assigned and the unassigned token)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    const assignedFilter = {
      ast: buildAst('and', [{ field: 'assignee', operator: 'is_any_of', value: [fx.ownerId] }]),
    };
    const unassignedFilter = {
      ast: buildAst('and', [
        { field: 'assignee', operator: 'is_any_of', value: [FILTER_UNASSIGNED_TOKEN] },
      ]),
    };

    const assigned = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter: assignedFilter,
    });
    expect(ids(assigned)).toEqual([items.a0!.id, items.a2!.id, items.a4!.id]);
    expect(
      await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, assignedFilter),
    ).toBe(3);

    const unassigned = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter: unassignedFilter,
    });
    expect(ids(unassigned)).toEqual([items.a1!.id, items.a3!.id]);
    expect(
      await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, unassignedFilter),
    ).toBe(2);
  });

  it('narrows by the TEXT facet (title contains)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    const filter = {
      ast: buildAst('and', [{ field: 'text', operator: 'contains', value: 'keep' }]),
    };

    const page = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter,
    });
    expect(ids(page)).toEqual([items.a2!.id, items.a3!.id]);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, filter)).toBe(2);
  });

  it('narrows by an advanced OR AST (beyond a single facet)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    // kind=story OR assignee=unassigned → {a2} ∪ {a1, a3} = {a1, a2, a3} in rank order.
    const filter = {
      ast: buildAst('or', [
        { field: 'kind', operator: 'is_any_of', value: ['story'] },
        { field: 'assignee', operator: 'is_any_of', value: [FILTER_UNASSIGNED_TOKEN] },
      ]),
    };

    const page = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter,
    });
    expect(ids(page)).toEqual([items.a1!.id, items.a2!.id, items.a3!.id]);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, filter)).toBe(3);
  });

  it('seek-paginates correctly with a filter applied (page 2 continues the filtered set)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    // type=code matches a0, a3, a4 (in rank order). Walk it one row at a time.
    const filter = {
      ast: buildAst('and', [{ field: 'type', operator: 'is_any_of', value: ['code'] }]),
    };

    const page1 = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 1,
      filter,
    });
    // take+1 over-fetch → 2 rows, the second signalling a next page.
    expect(ids(page1)).toEqual([items.a0!.id, items.a3!.id]);

    const page2 = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 1,
      cursor: items.a0!.id,
      filter,
    });
    expect(ids(page2)).toEqual([items.a3!.id, items.a4!.id]);

    const page3 = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 1,
      cursor: items.a3!.id,
      filter,
    });
    // Last filtered row — no over-fetch row, so no next page.
    expect(ids(page3)).toEqual([items.a4!.id]);
  });

  it('an UNFILTERED call is byte-identical to omitting the filter (regression guard)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    const all = [items.a0!.id, items.a1!.id, items.a2!.id, items.a3!.id, items.a4!.id];

    const noArg = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, { take: 50 });
    const undefinedFilter = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter: undefined,
    });
    // An empty-condition AST also takes the unfiltered path (no SQL change).
    const emptyAst = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      filter: { ast: buildAst('and', []) },
    });

    expect(ids(noArg)).toEqual(all);
    expect(ids(undefinedFilter)).toEqual(all);
    expect(ids(emptyAst)).toEqual(all);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId)).toBe(5);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId, undefined)).toBe(5);
  });

  it('is workspace-gated under a filter (a cross-workspace read returns [])', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    await seedMixed(fx, sprintId);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const filter = {
      ast: buildAst('and', [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }]),
    };
    expect(
      await workItemRepository.findSprintIssues(sprintId, other.workspaceId, { take: 50, filter }),
    ).toEqual([]);
    expect(await workItemRepository.countSprintIssues(sprintId, other.workspaceId, filter)).toBe(0);
  });
});

describe('sprint filtering — service (getSprintIssues resolves + validates)', () => {
  it('resolves a facet AST and returns the filtered page + count', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    const items = await seedMixed(fx, sprintId);
    const page = await backlogService.getSprintIssues(
      sprintId,
      { filterAst: buildAst('and', [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }]) },
      fx.ctx,
    );
    expect(page.items.map((i) => i.id)).toEqual([items.a1!.id, items.a3!.id]);
    expect(page.totalCount).toBe(2);
  });

  it('an all-filtered-out sprint returns 0 rows + 0 count (the dashed-placeholder case)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    await seedMixed(fx, sprintId);
    const page = await backlogService.getSprintIssues(
      sprintId,
      {
        filterAst: buildAst('and', [
          { field: 'text', operator: 'contains', value: 'zzz-no-match' },
        ]),
      },
      fx.ctx,
    );
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects an invalid filter with a typed FilterValidationError (→ 422)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    await seedMixed(fx, sprintId);
    await expect(
      backlogService.getSprintIssues(
        sprintId,
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

  it('an unfiltered getSprintIssues is unchanged (full sprint set + count)', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint(fx);
    await seedMixed(fx, sprintId);
    const page = await backlogService.getSprintIssues(sprintId, {}, fx.ctx);
    expect(page.items).toHaveLength(5);
    expect(page.totalCount).toBe(5);
  });
});
