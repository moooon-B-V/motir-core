import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { BOARD_SWIMLANE_NO_VALUE } from '@/lib/dto/boards';
import { SavedFilterNotFoundError } from '@/lib/savedFilters/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemKind, WorkItemType } from '@prisma/client';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// boardsService.getBoard — the FILTERED board read (Story 6.15.2). The board
// projection now accepts an optional advanced filter (an inline FilterAst built
// from the board's quick filter, OR a saved-filter id resolved through the 6.2
// access gate). The same compiled predicate is AND-ed into every column's card
// read + its `totalCount`, into the board-level `truncated`/cap denominator,
// and into the swimlane lane aggregates — so a filtered board shows ONLY
// matching cards everywhere, and a filter under the cap clears `truncated`. The
// 4.5 Scrum sprint scope composes WITH it (narrow within the sprint). Real
// Postgres (no mocks), per CLAUDE.md; `createTestProject` auto-seeds the default
// kanban board (one column per workflow status), so no manual board rows.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Board User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Board WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  const board = await db.board.findFirstOrThrow({ where: { projectId: project.id } });
  return {
    ctx,
    workspaceId: ws.workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    boardId: board.id,
  };
}

/** Create a card of `kind`, force it into `status`, and (optionally) stamp its
 * Work `type`, assignee, and sprint directly (the projection groups by these
 * columns; the write paths are other stories' tests). */
async function card(
  fx: Fixture,
  opts: {
    kind?: WorkItemKind;
    status: string;
    title: string;
    type?: WorkItemType | null;
    assigneeId?: string | null;
    sprintId?: string | null;
  },
): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: opts.kind ?? 'task', title: opts.title },
    fx.ctx,
  );
  await db.workItem.update({
    where: { id: item.id },
    data: {
      status: opts.status,
      ...(opts.type !== undefined ? { type: opts.type } : {}),
      ...(opts.assigneeId !== undefined ? { assigneeId: opts.assigneeId } : {}),
      ...(opts.sprintId !== undefined ? { sprintId: opts.sprintId } : {}),
    },
  });
  return item.id;
}

function columnByStatus(
  board: Awaited<ReturnType<typeof boardsService.getBoard>>,
  statusKey: string,
) {
  return board.columns.find((c) => c.statusKeys.includes(statusKey))!;
}

const kindAst = (...kinds: string[]): FilterAst => ({
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: kinds }],
});

describe('getBoard — filtered projection (6.15.2)', () => {
  it('applies the predicate per column — only matching cards, filtered totalCount', async () => {
    const fx = await makeFixture('filter-cols@example.com');
    await card(fx, { kind: 'bug', status: 'todo', title: 'Bug todo' });
    await card(fx, { kind: 'task', status: 'todo', title: 'Task todo' });
    await card(fx, { kind: 'bug', status: 'in_progress', title: 'Bug WIP' });
    await card(fx, { kind: 'task', status: 'done', title: 'Task done' });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: kindAst('bug'),
    });

    const todo = columnByStatus(board, 'todo');
    expect(todo.cards.map((c) => c.title)).toEqual(['Bug todo']);
    expect(todo.totalCount).toBe(1);

    const wip = columnByStatus(board, 'in_progress');
    expect(wip.cards.map((c) => c.title)).toEqual(['Bug WIP']);
    expect(wip.totalCount).toBe(1);

    const done = columnByStatus(board, 'done');
    expect(done.cards).toHaveLength(0);
    expect(done.totalCount).toBe(0);

    // No task ever leaks into the filtered board.
    const allTitles = board.columns.flatMap((c) => c.cards.map((card) => card.title));
    expect(allTitles).not.toContain('Task todo');
    expect(allTitles).not.toContain('Task done');
  });

  it('an absent or empty-condition filter is byte-identical to the unfiltered board', async () => {
    const fx = await makeFixture('filter-noop@example.com');
    await card(fx, { kind: 'bug', status: 'todo', title: 'A' });
    await card(fx, { kind: 'task', status: 'in_progress', title: 'B' });

    const base = await boardsService.getBoard(fx.projectId, fx.ctx);
    const undefinedFilter = await boardsService.getBoard(
      fx.projectId,
      fx.ctx,
      undefined,
      undefined,
    );
    const emptyAst = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: { combinator: 'and', conditions: [] },
    });

    const shape = (b: Awaited<ReturnType<typeof boardsService.getBoard>>) =>
      b.columns.map((c) => ({
        statusKeys: c.statusKeys,
        totalCount: c.totalCount,
        cardTitles: c.cards.map((card) => card.title),
      }));

    expect(shape(undefinedFilter)).toEqual(shape(base));
    expect(shape(emptyAst)).toEqual(shape(base));
    expect(base.truncated).toBe(false);
  });

  it('computes truncated over the FILTERED set — a filter under the cap clears it', async () => {
    const fx = await makeFixture('filter-cap@example.com');
    // Shrink the board cap to 3 so a handful of rows can exceed it.
    const prior = process.env.BOARD_ISSUE_CAP_OVERRIDE;
    process.env.BOARD_ISSUE_CAP_OVERRIDE = '3';
    try {
      for (let i = 0; i < 5; i++) {
        await card(fx, { kind: 'task', status: 'todo', title: `Task ${i}` });
      }
      await card(fx, { kind: 'bug', status: 'todo', title: 'Bug 0' });
      await card(fx, { kind: 'bug', status: 'todo', title: 'Bug 1' });

      const unfiltered = await boardsService.getBoard(fx.projectId, fx.ctx);
      expect(unfiltered.cap).toBe(3);
      expect(unfiltered.truncated).toBe(true); // 7 cards > cap 3

      const filtered = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
        ast: kindAst('bug'),
      });
      expect(filtered.cap).toBe(3);
      expect(filtered.truncated).toBe(false); // 2 bugs <= cap 3
      const todo = columnByStatus(filtered, 'todo');
      expect(todo.cards.map((c) => c.title).sort()).toEqual(['Bug 0', 'Bug 1']);
    } finally {
      if (prior === undefined) delete process.env.BOARD_ISSUE_CAP_OVERRIDE;
      else process.env.BOARD_ISSUE_CAP_OVERRIDE = prior;
    }
  });

  it('composes with the Scrum sprint scope — narrows WITHIN the sprint, never widening', async () => {
    const fx = await makeFixture('filter-scrum@example.com');
    await db.board.update({ where: { id: fx.boardId }, data: { type: 'scrum' } });
    const sprint = await db.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Sprint 1',
        state: 'active',
        sequence: 1,
      },
    });

    await card(fx, { kind: 'bug', status: 'todo', title: 'Bug in sprint', sprintId: sprint.id });
    await card(fx, { kind: 'task', status: 'todo', title: 'Task in sprint', sprintId: sprint.id });
    await card(fx, { kind: 'bug', status: 'todo', title: 'Bug OUT of sprint', sprintId: null });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: kindAst('bug'),
    });

    const todo = columnByStatus(board, 'todo');
    // Only the bug that is BOTH a bug AND in the active sprint — the filter
    // composes with (does not replace) the sprint scope.
    expect(todo.cards.map((c) => c.title)).toEqual(['Bug in sprint']);
    expect(todo.totalCount).toBe(1);
  });

  it('filters the swimlane lanes + counts on a grouped board', async () => {
    const fx = await makeFixture('filter-lanes@example.com');
    await db.board.update({ where: { id: fx.boardId }, data: { swimlaneGroupBy: 'assignee' } });

    // The only BUG is unassigned; the assigned card is a task (filtered out).
    await card(fx, { kind: 'bug', status: 'todo', title: 'Bug unassigned', assigneeId: null });
    await card(fx, {
      kind: 'task',
      status: 'todo',
      title: 'Task assigned',
      assigneeId: fx.ctx.userId,
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: kindAst('bug'),
    });

    // The assignee lane for the task's owner disappears; only the catch-all
    // ("No assignee") lane survives, counting the single matching bug.
    expect(board.swimlanes).toHaveLength(1);
    expect(board.swimlanes[0]!.key).toBe(BOARD_SWIMLANE_NO_VALUE);
    expect(board.swimlanes[0]!.count).toBe(1);
    expect(board.swimlanes.some((l) => l.key === fx.ctx.userId)).toBe(false);
  });

  it('filters by Work type (the `type` field compiles into the board read)', async () => {
    const fx = await makeFixture('filter-type@example.com');
    await card(fx, { status: 'todo', title: 'Design item', type: 'design' });
    await card(fx, { status: 'todo', title: 'Code item', type: 'code' });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      ast: {
        combinator: 'and',
        conditions: [{ field: 'type', operator: 'is_any_of', value: ['design'] }],
      },
    });

    const todo = columnByStatus(board, 'todo');
    expect(todo.cards.map((c) => c.title)).toEqual(['Design item']);
    expect(todo.totalCount).toBe(1);
  });

  it('resolves a saved-filter id through the 6.2 gate and filters the board', async () => {
    const fx = await makeFixture('filter-saved@example.com');
    await card(fx, { kind: 'bug', status: 'todo', title: 'Bug card' });
    await card(fx, { kind: 'task', status: 'todo', title: 'Task card' });

    const saved = await savedFiltersService.create(
      fx.projectKey,
      { name: 'Bugs only', visibility: 'private', filterParam: encodeFilterParam(kindAst('bug')) },
      fx.ctx,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
      savedFilterId: saved.id,
    });

    const todo = columnByStatus(board, 'todo');
    expect(todo.cards.map((c) => c.title)).toEqual(['Bug card']);
    expect(todo.totalCount).toBe(1);
  });

  it('throws SavedFilterNotFoundError for an unknown / unauthorized saved-filter id', async () => {
    const fx = await makeFixture('filter-saved-missing@example.com');
    await card(fx, { kind: 'bug', status: 'todo', title: 'Bug card' });

    await expect(
      boardsService.getBoard(fx.projectId, fx.ctx, undefined, {
        savedFilterId: 'does-not-exist',
      }),
    ).rejects.toBeInstanceOf(SavedFilterNotFoundError);
  });
});
