import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the board data-access leaves (Story 3.1 ·
// Subtask 3.1.3): boardRepository / boardColumnRepository /
// boardColumnStatusRepository. Real Postgres (no mocks), per CLAUDE.md.
//
// These assert the repository CONTRACT — the single-Prisma-op reads/writes and
// the explicit application-layer `workspaceId` gate (finding #26) every method
// applies on TOP of RLS. They run as the dev/CI superuser via the `db`
// singleton: under BYPASSRLS the RLS policy is inert, so a cross-workspace
// read returning [] / null PROVES the repository's own WHERE-clause gate, not
// the DB policy (the RLS policy itself is proven separately by the 3.1.1
// tests/boards/rls.test.ts under the prodect_app role). The representative
// write runs inside a real `db.$transaction` to exercise the required-`tx`
// write path.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades to project → board / board_column / board_column_status (all FK
  // the workspace with onDelete: Cascade), so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

let positionCounter = 0;
function nextPosition(): string {
  // Any strictly-increasing text is a valid fractional-index `position` for
  // these fixtures (we never reorder them). Monotonic base-36 keeps them
  // unique and lexically ordered without pulling in the positioning helper.
  positionCounter += 1;
  return `a${positionCounter.toString(36)}`;
}

async function makeStatus(args: {
  workspaceId: string;
  projectId: string;
  key: string;
}): Promise<string> {
  const row = await db.workflowStatus.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      key: args.key,
      label: args.key,
      category: 'todo',
      position: nextPosition(),
    },
  });
  return row.id;
}

interface BoardTenantFixture {
  workspaceId: string;
  projectId: string;
  boardId: string;
  // two columns, in position order, each mapped to one status
  column1Id: string;
  column2Id: string;
  status1Id: string;
  status2Id: string;
  mapping1Id: string;
  mapping2Id: string;
}

// One tenant: a workspace (real service) + a bare project + two workflow
// statuses + a board with two ordered columns, each mapping one status. All
// board rows inserted directly (the seed wiring is 3.1.2 — not yet built); the
// repositories under test only READ/WRITE these rows.
async function makeBoardTenant(label: string): Promise<BoardTenantFixture> {
  const user = await usersService.createUser({
    email: `board-${label}@example.com`,
    password: 'hunter2hunter2',
    name: `Board ${label}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Board WS ${label}`,
    ownerUserId: user.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await db.project.create({
    data: { workspaceId, name: `Board P ${label}`, slug: 'board-repo', identifier: 'BRD' },
  });
  const projectId = project.id;

  const status1Id = await makeStatus({ workspaceId, projectId, key: 'todo' });
  const status2Id = await makeStatus({ workspaceId, projectId, key: 'done' });

  const board = await db.board.create({
    data: { workspaceId, projectId, name: 'Board', type: 'kanban', position: 'a0' },
  });
  const column1 = await db.boardColumn.create({
    data: { workspaceId, projectId, boardId: board.id, name: 'To Do', position: nextPosition() },
  });
  const column2 = await db.boardColumn.create({
    data: { workspaceId, projectId, boardId: board.id, name: 'Done', position: nextPosition() },
  });
  const mapping1 = await db.boardColumnStatus.create({
    data: { workspaceId, projectId, boardId: board.id, columnId: column1.id, statusId: status1Id },
  });
  const mapping2 = await db.boardColumnStatus.create({
    data: { workspaceId, projectId, boardId: board.id, columnId: column2.id, statusId: status2Id },
  });

  return {
    workspaceId,
    projectId,
    boardId: board.id,
    column1Id: column1.id,
    column2Id: column2.id,
    status1Id,
    status2Id,
    mapping1Id: mapping1.id,
    mapping2Id: mapping2.id,
  };
}

describe('boardRepository — reads + workspace gate', () => {
  it('findByProject returns the project board(s) for the right workspace', async () => {
    const fx = await makeBoardTenant('a');
    const boards = await boardRepository.findByProject(fx.projectId, fx.workspaceId);
    expect(boards.map((b) => b.id)).toEqual([fx.boardId]);
    expect(boards[0]?.type).toBe('kanban');
  });

  it('findByProject is workspace-gated — a foreign workspaceId returns []', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    // a's project id, b's workspace id → no rows (the explicit gate, not RLS)
    const boards = await boardRepository.findByProject(a.projectId, b.workspaceId);
    expect(boards).toEqual([]);
  });

  it('findDefaultForProject returns the board, null cross-workspace', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    const own = await boardRepository.findDefaultForProject(a.projectId, a.workspaceId);
    expect(own?.id).toBe(a.boardId);
    const foreign = await boardRepository.findDefaultForProject(a.projectId, b.workspaceId);
    expect(foreign).toBeNull();
  });

  it('findById returns the board, null cross-workspace', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    expect((await boardRepository.findById(a.boardId, a.workspaceId))?.id).toBe(a.boardId);
    expect(await boardRepository.findById(a.boardId, b.workspaceId)).toBeNull();
  });
});

describe('boardColumnRepository — reads, batched read + workspace gate', () => {
  it('findByBoard returns columns in position order', async () => {
    const fx = await makeBoardTenant('a');
    const cols = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(cols.map((c) => c.id)).toEqual([fx.column1Id, fx.column2Id]);
    expect(cols.map((c) => c.name)).toEqual(['To Do', 'Done']);
  });

  it('findByBoard is workspace-gated — foreign workspaceId returns []', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    expect(await boardColumnRepository.findByBoard(a.boardId, b.workspaceId)).toEqual([]);
  });

  it('findByBoards batches across boards and stays workspace-scoped (no N+1, no leak)', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    // Ask for BOTH boards but under workspace A → only A's columns come back.
    const cols = await boardColumnRepository.findByBoards([a.boardId, b.boardId], a.workspaceId);
    expect(cols.map((c) => c.id).sort()).toEqual([a.column1Id, a.column2Id].sort());
    expect(cols.every((c) => c.boardId === a.boardId)).toBe(true);
  });

  it('findByBoards short-circuits on empty input', async () => {
    const a = await makeBoardTenant('a');
    expect(await boardColumnRepository.findByBoards([], a.workspaceId)).toEqual([]);
  });

  it('findById returns the column, null cross-workspace', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    expect((await boardColumnRepository.findById(a.column1Id, a.workspaceId))?.id).toBe(
      a.column1Id,
    );
    expect(await boardColumnRepository.findById(a.column1Id, b.workspaceId)).toBeNull();
  });
});

describe('boardColumnStatusRepository — mapping reads + workspace gate', () => {
  it('findByBoard returns every column→status edge for the board', async () => {
    const fx = await makeBoardTenant('a');
    const maps = await boardColumnStatusRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(maps.map((m) => m.id).sort()).toEqual([fx.mapping1Id, fx.mapping2Id].sort());
  });

  it('findByColumn returns a single column’s mapped status', async () => {
    const fx = await makeBoardTenant('a');
    const maps = await boardColumnStatusRepository.findByColumn(fx.column1Id, fx.workspaceId);
    expect(maps.map((m) => m.statusId)).toEqual([fx.status1Id]);
  });

  it('mapping reads are workspace-gated', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    expect(await boardColumnStatusRepository.findByBoard(a.boardId, b.workspaceId)).toEqual([]);
    expect(await boardColumnStatusRepository.findByColumn(a.column1Id, b.workspaceId)).toEqual([]);
  });
});

describe('board writes — required-tx create + delete under a transaction', () => {
  it('create persists a board + column + mapping inside one transaction', async () => {
    const fx = await makeBoardTenant('a');
    // A fresh project in the same workspace, with one status to map.
    const project = await db.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Write P',
        slug: 'board-write',
        identifier: 'BWR',
      },
    });
    const statusId = await makeStatus({
      workspaceId: fx.workspaceId,
      projectId: project.id,
      key: 'todo',
    });

    const created = await db.$transaction(async (tx) => {
      const board = await boardRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: project.id,
          name: 'Board',
          type: 'kanban',
          position: 'a0',
        },
        tx,
      );
      const column = await boardColumnRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: project.id,
          boardId: board.id,
          name: 'To Do',
          position: nextPosition(),
        },
        tx,
      );
      const mapping = await boardColumnStatusRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: project.id,
          boardId: board.id,
          columnId: column.id,
          statusId,
        },
        tx,
      );
      return { boardId: board.id, columnId: column.id, mappingId: mapping.id };
    });

    // Re-read through the repositories to prove the rows committed.
    expect((await boardRepository.findById(created.boardId, fx.workspaceId))?.id).toBe(
      created.boardId,
    );
    const cols = await boardColumnRepository.findByBoard(created.boardId, fx.workspaceId);
    expect(cols.map((c) => c.id)).toEqual([created.columnId]);
    const maps = await boardColumnStatusRepository.findByBoard(created.boardId, fx.workspaceId);
    expect(maps.map((m) => m.id)).toEqual([created.mappingId]);
  });

  it('deleteByStatus removes only that board’s mapping for the status', async () => {
    const fx = await makeBoardTenant('a');
    const removed = await db.$transaction((tx) =>
      boardColumnStatusRepository.deleteByStatus(fx.boardId, fx.status1Id, tx),
    );
    expect(removed).toBe(1);
    const remaining = await boardColumnStatusRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(remaining.map((m) => m.id)).toEqual([fx.mapping2Id]);
  });

  it('deleteByColumn removes the column’s mappings', async () => {
    const fx = await makeBoardTenant('a');
    const removed = await db.$transaction((tx) =>
      boardColumnStatusRepository.deleteByColumn(fx.column1Id, tx),
    );
    expect(removed).toBe(1);
    const remaining = await boardColumnStatusRepository.findByColumn(fx.column1Id, fx.workspaceId);
    expect(remaining).toEqual([]);
  });

  it('update mutates a column (rename / wip-limit) under a transaction', async () => {
    const fx = await makeBoardTenant('a');
    const updated = await db.$transaction((tx) =>
      boardColumnRepository.update(fx.column1Id, { name: 'Backlog', wipLimit: 5 }, tx),
    );
    expect(updated.name).toBe('Backlog');
    expect(updated.wipLimit).toBe(5);
  });
});
