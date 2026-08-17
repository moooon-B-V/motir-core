import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

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
// tests/boards/rls.test.ts under the motir_app role). The representative
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
  await adminDb.$disconnect();
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
  const row = await adminDb.workflowStatus.create({
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
  const project = await adminDb.project.create({
    data: { workspaceId, name: `Board P ${label}`, slug: 'board-repo', identifier: 'BRD' },
  });
  const projectId = project.id;

  const status1Id = await makeStatus({ workspaceId, projectId, key: 'todo' });
  const status2Id = await makeStatus({ workspaceId, projectId, key: 'done' });

  const board = await adminDb.board.create({
    // isDefault mirrors the real auto-seed (3.1.2): a project's sole board is its
    // default, which is what findDefaultForProject now resolves on (3.7.5).
    data: {
      workspaceId,
      projectId,
      name: 'Board',
      type: 'kanban',
      position: 'a0',
      isDefault: true,
    },
  });
  const column1 = await adminDb.boardColumn.create({
    data: { workspaceId, projectId, boardId: board.id, name: 'To Do', position: nextPosition() },
  });
  const column2 = await adminDb.boardColumn.create({
    data: { workspaceId, projectId, boardId: board.id, name: 'Done', position: nextPosition() },
  });
  const mapping1 = await adminDb.boardColumnStatus.create({
    data: { workspaceId, projectId, boardId: board.id, columnId: column1.id, statusId: status1Id },
  });
  const mapping2 = await adminDb.boardColumnStatus.create({
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
    const boards = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardRepository.findByProject(fx.projectId, fx.workspaceId, tx),
    );
    expect(boards.map((b) => b.id)).toEqual([fx.boardId]);
    expect(boards[0]?.type).toBe('kanban');
  });

  it('findByProject is workspace-gated — a foreign workspaceId returns []', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    // a's project id, b's workspace id → no rows (the explicit gate, not RLS)
    const boards = await withWorkspaceServiceContext(a.workspaceId, (tx) =>
      boardRepository.findByProject(a.projectId, b.workspaceId, tx),
    );
    expect(boards).toEqual([]);
  });

  it('findDefaultForProject returns the board, null cross-workspace', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    // Bound to `a` — the workspace the POSITIVE assertion is about. Bound to `b`
    // (as this read was until MOTIR-2881) the policy hides a's board and the row
    // never arrives: `expected undefined to be <board>`.
    const own = await withWorkspaceServiceContext(a.workspaceId, (tx) =>
      boardRepository.findDefaultForProject(a.projectId, a.workspaceId, tx),
    );
    expect(own?.id).toBe(a.boardId);
    const foreign = await withWorkspaceServiceContext(a.workspaceId, (tx) =>
      boardRepository.findDefaultForProject(a.projectId, b.workspaceId, tx),
    );
    expect(foreign).toBeNull();
  });

  it('findById returns the board, null cross-workspace', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    // Bound to `a` for the positive half (MOTIR-2881) — see findDefaultForProject.
    expect(
      (
        await withWorkspaceServiceContext(a.workspaceId, (tx) =>
          boardRepository.findById(a.boardId, a.workspaceId, tx),
        )
      )?.id,
    ).toBe(a.boardId);
    expect(
      await withWorkspaceServiceContext(a.workspaceId, (tx) =>
        boardRepository.findById(a.boardId, b.workspaceId, tx),
      ),
    ).toBeNull();
  });
});

describe('boardColumnRepository — reads, batched read + workspace gate', () => {
  it('findByBoard returns columns in position order', async () => {
    const fx = await makeBoardTenant('a');
    const cols = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId, tx),
    );
    expect(cols.map((c) => c.id)).toEqual([fx.column1Id, fx.column2Id]);
    expect(cols.map((c) => c.name)).toEqual(['To Do', 'Done']);
  });

  it('findByBoard is workspace-gated — foreign workspaceId returns []', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    expect(
      await withWorkspaceServiceContext(a.workspaceId, (tx) =>
        boardColumnRepository.findByBoard(a.boardId, b.workspaceId, tx),
      ),
    ).toEqual([]);
  });

  it('findByBoards batches across boards and stays workspace-scoped (no N+1, no leak)', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    // Ask for BOTH boards but under workspace A → only A's columns come back.
    // Bound to `a` (MOTIR-2881): the read has to be able to SEE a's columns for the
    // batching claim to mean anything, and b's are then excluded twice over — by the
    // explicit `workspaceId` argument and by the policy. The WHERE-clause gate on its
    // own is what the foreign-argument tests above and below isolate.
    const cols = await withWorkspaceServiceContext(a.workspaceId, (tx) =>
      boardColumnRepository.findByBoards([a.boardId, b.boardId], a.workspaceId, tx),
    );
    expect(cols.map((c) => c.id).sort()).toEqual([a.column1Id, a.column2Id].sort());
    expect(cols.every((c) => c.boardId === a.boardId)).toBe(true);
  });

  it('findByBoards short-circuits on empty input', async () => {
    const a = await makeBoardTenant('a');
    expect(
      await withWorkspaceServiceContext(a.workspaceId, (tx) =>
        boardColumnRepository.findByBoards([], a.workspaceId, tx),
      ),
    ).toEqual([]);
  });

  it('findById returns the column, null cross-workspace', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    // Bound to `a` for the positive half (MOTIR-2881) — see findDefaultForProject.
    expect(
      (
        await withWorkspaceServiceContext(a.workspaceId, (tx) =>
          boardColumnRepository.findById(a.column1Id, a.workspaceId, tx),
        )
      )?.id,
    ).toBe(a.column1Id);
    // ⚠️ Bound to `a`, READ for `b`: the policy admits a's rows, so a null can
    // ONLY come from the explicit workspaceId argument — which is the gate this
    // test asserts. Binding `b` would hide the row twice and prove nothing.
    expect(
      await withWorkspaceServiceContext(a.workspaceId, (tx) =>
        boardColumnRepository.findById(a.column1Id, b.workspaceId, tx),
      ),
    ).toBeNull();
  });
});

describe('boardColumnStatusRepository — mapping reads + workspace gate', () => {
  it('findByBoard returns every column→status edge for the board', async () => {
    const fx = await makeBoardTenant('a');
    const maps = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.findByBoard(fx.boardId, fx.workspaceId, tx),
    );
    expect(maps.map((m) => m.id).sort()).toEqual([fx.mapping1Id, fx.mapping2Id].sort());
  });

  it('findByColumn returns a single column’s mapped status', async () => {
    const fx = await makeBoardTenant('a');
    const maps = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.findByColumn(fx.column1Id, fx.workspaceId, tx),
    );
    expect(maps.map((m) => m.statusId)).toEqual([fx.status1Id]);
  });

  it('mapping reads are workspace-gated', async () => {
    const a = await makeBoardTenant('a');
    const b = await makeBoardTenant('b');
    expect(
      await withWorkspaceServiceContext(a.workspaceId, (tx) =>
        boardColumnStatusRepository.findByBoard(a.boardId, b.workspaceId, tx),
      ),
    ).toEqual([]);
    expect(
      await withWorkspaceServiceContext(a.workspaceId, (tx) =>
        boardColumnStatusRepository.findByColumn(a.column1Id, b.workspaceId, tx),
      ),
    ).toEqual([]);
  });
});

describe('board writes — required-tx create + delete under a transaction', () => {
  it('create persists a board + column + mapping inside one transaction', async () => {
    const fx = await makeBoardTenant('a');
    // A fresh project in the same workspace, with one status to map.
    const project = await adminDb.project.create({
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

    // Bound to the workspace tier (MOTIR-2792). `withWorkspaceServiceContext` rather
    // than `withWorkspaceContext` because this fixture carries no actor — board rows
    // are workspace-scoped and need no user to be admitted.
    const created = await withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
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
    expect(
      (
        await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
          boardRepository.findById(created.boardId, fx.workspaceId, tx),
        )
      )?.id,
    ).toBe(created.boardId);
    const cols = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnRepository.findByBoard(created.boardId, fx.workspaceId, tx),
    );
    expect(cols.map((c) => c.id)).toEqual([created.columnId]);
    const maps = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.findByBoard(created.boardId, fx.workspaceId, tx),
    );
    expect(maps.map((m) => m.id)).toEqual([created.mappingId]);
  });

  it('deleteByStatus removes only that board’s mapping for the status', async () => {
    const fx = await makeBoardTenant('a');
    const removed = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.deleteByStatus(fx.boardId, fx.status1Id, tx),
    );
    expect(removed).toBe(1);
    const remaining = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.findByBoard(fx.boardId, fx.workspaceId, tx),
    );
    expect(remaining.map((m) => m.id)).toEqual([fx.mapping2Id]);
  });

  it('deleteByColumn removes the column’s mappings', async () => {
    const fx = await makeBoardTenant('a');
    const removed = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.deleteByColumn(fx.column1Id, tx),
    );
    expect(removed).toBe(1);
    const remaining = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnStatusRepository.findByColumn(fx.column1Id, fx.workspaceId, tx),
    );
    expect(remaining).toEqual([]);
  });

  it('update mutates a column (rename / wip-limit) under a transaction', async () => {
    const fx = await makeBoardTenant('a');
    const updated = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      boardColumnRepository.update(fx.column1Id, { name: 'Backlog', wipLimit: 5 }, tx),
    );
    expect(updated.name).toBe('Backlog');
    expect(updated.wipLimit).toBe(5);
  });
});
