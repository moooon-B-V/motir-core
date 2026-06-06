import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { BoardNotFoundError } from '@/lib/boards/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// boardsService.getBoard / loadColumnCards (Story 3.1 · Subtask 3.1.4). Real
// Postgres (no mocks), per CLAUDE.md. createTestProject → createProject auto-
// seeds BOTH the default workflow (statuses todo / blocked / in_progress /
// in_review / done / cancelled, in that position order) AND the default board
// (3.1.2): one column per status, each mapped to its status. So getBoard reads
// a fully-seeded board with no manual row inserts.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

const DEFAULT_KEYS = ['todo', 'blocked', 'in_progress', 'in_review', 'done', 'cancelled'];

interface Fixture {
  ctx: ServiceContext;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(email: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email,
    password: 'hunter2hunter2',
    name: 'Proj User',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Proj WS', ownerUserId: user.id });
  const ctx: ServiceContext = { userId: user.id, workspaceId: ws.workspace.id };
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: user.id });
  return { ctx, workspaceId: ws.workspace.id, projectId: project.id };
}

/** Create an issue (lands in `todo`) and force it into `status` (the projection
 * groups by `work_item.status`; we set it directly rather than walk the
 * transition graph — the transition path is 3.1.5's test, not this one). */
async function cardInStatus(fx: Fixture, status: string, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  if (status !== 'todo') {
    await db.workItem.update({ where: { id: item.id }, data: { status } });
  }
  return item.id;
}

/** Bulk-insert `n` cards directly in `status` with deterministic positions —
 * fast fixture for the scale/pagination assertions (keys start at 1000 to avoid
 * colliding with service-allocated keys). */
async function bulkCards(fx: Fixture, status: string, n: number): Promise<void> {
  const project = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  await db.workItem.createMany({
    data: Array.from({ length: n }, (_, i) => {
      const key = 1000 + i;
      return {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task' as const,
        key,
        identifier: `${project.identifier}-${key}`,
        title: `Bulk ${i}`,
        status,
        reporterId: fx.ctx.userId,
        // zero-padded so the lexicographic position sort is the insertion order
        position: `p${String(i).padStart(4, '0')}`,
      };
    }),
  });
}

describe('boardsService.getBoard — projection', () => {
  it('groups cards into the right columns in workflow order, with per-column counts', async () => {
    const fx = await makeFixture('proj-group@example.com');
    await cardInStatus(fx, 'todo', 'A');
    await cardInStatus(fx, 'todo', 'B');
    await cardInStatus(fx, 'in_progress', 'C');
    await cardInStatus(fx, 'done', 'D');

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.columns.map((c) => c.statusKeys[0])).toEqual(DEFAULT_KEYS);
    const byKey = new Map(board.columns.map((c) => [c.statusKeys[0], c]));
    expect(byKey.get('todo')!.totalCount).toBe(2);
    expect(byKey.get('todo')!.cards).toHaveLength(2);
    expect(byKey.get('in_progress')!.totalCount).toBe(1);
    expect(byKey.get('done')!.totalCount).toBe(1);
    expect(byKey.get('blocked')!.cards).toHaveLength(0);
    expect(byKey.get('blocked')!.cursor).toBeNull();
    expect(board.unmappedStatuses).toHaveLength(0);
    // every card carries the readiness flag (no blockers → ready)
    expect(byKey.get('todo')!.cards.every((c) => c.ready)).toBe(true);
  });

  it('surfaces a status mapped to no column in unmappedStatuses (never a column, never dropped)', async () => {
    const fx = await makeFixture('proj-unmapped@example.com');
    await workflowsService.createStatus({
      userId: fx.ctx.userId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'needs_triage',
      label: 'Needs Triage',
      category: 'todo',
    });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);

    expect(board.unmappedStatuses.map((s) => s.key)).toEqual(['needs_triage']);
    // still the original six columns; the new status is NOT one of them
    expect(board.columns).toHaveLength(DEFAULT_KEYS.length);
    expect(board.columns.flatMap((c) => c.statusKeys)).not.toContain('needs_triage');
  });

  it('bounds a column to a page + cursor; loadColumnCards returns the next page (finding #57)', async () => {
    const fx = await makeFixture('proj-page@example.com');
    await bulkCards(fx, 'todo', 51); // one over the 50 page size

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    expect(todo.totalCount).toBe(51);
    expect(todo.cards).toHaveLength(50); // never the whole column
    expect(todo.cursor).not.toBeNull();

    const next = await boardsService.loadColumnCards(board.boardId, todo.id, todo.cursor, fx.ctx);
    expect(next.cards).toHaveLength(1);
    expect(next.cursor).toBeNull();
    // no row appears on both pages
    const firstIds = new Set(todo.cards.map((c) => c.id));
    expect(next.cards.every((c) => !firstIds.has(c.id))).toBe(true);
  });

  it('orders a terminal (done) column by recency, not rank', async () => {
    const fx = await makeFixture('proj-terminal@example.com');
    // earlierByPosition has the EARLIER position but is touched LAST, so
    // position-order and recency-order disagree — proving the done column uses
    // recency (most-recently-updated first).
    const project = await db.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    await db.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 2001,
        identifier: `${project.identifier}-2001`,
        title: 'earlier position',
        status: 'done',
        reporterId: fx.ctx.userId,
        position: 'pa',
      },
    });
    const laterPos = await db.workItem.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        kind: 'task',
        key: 2002,
        identifier: `${project.identifier}-2002`,
        title: 'later position, touched last',
        status: 'done',
        reporterId: fx.ctx.userId,
        position: 'pb',
      },
    });
    // touch the later-position card so it is the most recently updated
    await db.workItem.update({ where: { id: laterPos.id }, data: { title: 'touched' } });

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const done = board.columns.find((c) => c.statusKeys[0] === 'done')!;
    expect(done.cards[0]!.id).toBe(laterPos.id); // recency wins over position
  });

  it('is workspace-scoped — a board read for another workspace 404s, and never leaks cards', async () => {
    const a = await makeFixture('proj-ws-a@example.com');
    const b = await makeFixture('proj-ws-b@example.com');
    await cardInStatus(a, 'todo', 'A-only');

    // B's context cannot read A's board (the board lookup is workspace-scoped).
    await expect(boardsService.getBoard(a.projectId, b.ctx)).rejects.toBeInstanceOf(
      BoardNotFoundError,
    );

    // B's own board sees none of A's cards.
    const boardB = await boardsService.getBoard(b.projectId, b.ctx);
    expect(boardB.columns.every((c) => c.totalCount === 0)).toBe(true);
  });

  it('marks a card with an open (non-terminal) blocker as not ready (batch readiness, finding #21)', async () => {
    const fx = await makeFixture('proj-ready@example.com');
    const blocker = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'blocker (todo = non-terminal)' },
      fx.ctx,
    );
    const blocked = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'blocked by the open blocker',
        links: [{ targetId: blocker.id, relationship: 'blocked_by' }],
      },
      fx.ctx,
    );

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;
    const cardById = new Map(todo.cards.map((c) => [c.id, c]));
    expect(cardById.get(blocked.id)!.ready).toBe(false); // open blocker → not ready
    expect(cardById.get(blocker.id)!.ready).toBe(true); // the blocker itself has none
  });

  it('findBlockerStatesForItems short-circuits an empty id set without a query', async () => {
    expect(await workItemLinkRepository.findBlockerStatesForItems([])).toEqual([]);
  });
});
