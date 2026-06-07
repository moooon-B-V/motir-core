import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { keyBetween } from '@/lib/workItems/positioning';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  ColumnNotEmptyError,
  InvalidBoardNameError,
  InvalidColumnNameError,
  InvalidColumnPositionError,
  LastColumnError,
  NotBoardAdminError,
} from '@/lib/boards/errors';
import { WorkflowStatusNotFoundError } from '@/lib/workflows/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// boardsService column-config admin (Story 3.6 · Subtask 3.6.2) — add / rename /
// reorder / delete a column, map / unmap a status, rename the board. Real
// Postgres (no mocks), per CLAUDE.md. createTestProject → createProject auto-
// seeds the default board with one column per workflow status (todo / blocked /
// in_progress / in_review / done / cancelled), each mapped to its status, so the
// config writes here operate on a real seeded board.
//
// Authorization: board config is workspace-OWNER-gated (finding #36), mirroring
// the 3.3.3 WIP/group-by writes — so an owner succeeds and a plain member is
// denied (NotBoardAdminError). Tenancy (finding #26): a board / column from
// another workspace is a 404 (no cross-tenant existence leak).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  workspaceId: string;
  projectId: string;
  boardId: string;
  /** column id keyed by the workflow-status key it maps in the seeded board. */
  columnByStatusKey: Map<string, string>;
  /** workflow-status id keyed by its key. */
  statusIdByKey: Map<string, string>;
}

async function makeFixture(label: string): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `col-cfg-owner-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Config Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Config WS ${label}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });

  const member = await usersService.createUser({
    email: `col-cfg-member-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Config Member',
  });
  await db.workspaceMembership.create({
    data: { userId: member.id, workspaceId, role: 'member' },
  });

  const board = await boardRepository.findDefaultForProject(project.id, workspaceId);
  if (!board) throw new Error('expected a seeded default board');

  const statuses = await db.workflowStatus.findMany({ where: { projectId: project.id } });
  const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));

  // Each seeded column maps exactly one status; index columns by that key.
  const mappings = await db.boardColumnStatus.findMany({ where: { boardId: board.id } });
  const keyByStatusId = new Map(statuses.map((s) => [s.id, s.key]));
  const columnByStatusKey = new Map<string, string>();
  for (const m of mappings) {
    const key = keyByStatusId.get(m.statusId);
    if (key) columnByStatusKey.set(key, m.columnId);
  }

  return {
    ownerCtx: { userId: owner.id, workspaceId },
    memberCtx: { userId: member.id, workspaceId },
    workspaceId,
    projectId: project.id,
    boardId: board.id,
    columnByStatusKey,
    statusIdByKey,
  };
}

/** Create an issue and force it into `status` (mirrors projection.test.ts). */
async function cardInStatus(fx: Fixture, status: string, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ownerCtx,
  );
  if (status !== 'todo') {
    await db.workItem.update({ where: { id: item.id }, data: { status } });
  }
  return item.id;
}

describe('boardsService.addColumn (Subtask 3.6.2)', () => {
  it('appends a column to the end and persists it', async () => {
    const fx = await makeFixture('add');
    const before = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);

    const dto = await boardsService.addColumn(fx.boardId, { name: 'Triage' }, fx.ownerCtx);
    expect(dto).toMatchObject({ name: 'Triage', wipLimit: null });

    const after = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(after).toHaveLength(before.length + 1);
    // appended last (highest position)
    expect(after[after.length - 1]!.id).toBe(dto.id);
  });

  it('inserts at an explicit position when given', async () => {
    const fx = await makeFixture('add-pos');
    const cols = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    const between = keyBetween(cols[0]!.position, cols[1]!.position);

    const dto = await boardsService.addColumn(
      fx.boardId,
      { name: 'Inserted', position: between },
      fx.ownerCtx,
    );

    const after = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(after[1]!.id).toBe(dto.id);
  });

  it('trims the name and rejects an empty one with InvalidColumnNameError', async () => {
    const fx = await makeFixture('add-empty');
    await expect(
      boardsService.addColumn(fx.boardId, { name: '   ' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidColumnNameError);

    const dto = await boardsService.addColumn(fx.boardId, { name: '  Spaced  ' }, fx.ownerCtx);
    expect(dto.name).toBe('Spaced');
  });

  it('denies a non-owner member (no write)', async () => {
    const fx = await makeFixture('add-member');
    const before = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    await expect(
      boardsService.addColumn(fx.boardId, { name: 'Nope' }, fx.memberCtx),
    ).rejects.toBeInstanceOf(NotBoardAdminError);
    const after = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(after).toHaveLength(before.length);
  });

  it('treats a cross-workspace board as not found (404, no leak)', async () => {
    const fx = await makeFixture('add-tA');
    const other = await makeFixture('add-tB');
    await expect(
      boardsService.addColumn(fx.boardId, { name: 'X' }, other.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});

describe('boardsService.renameColumn (Subtask 3.6.2)', () => {
  it('renames a column and persists it', async () => {
    const fx = await makeFixture('rename');
    const columnId = fx.columnByStatusKey.get('todo')!;
    const dto = await boardsService.renameColumn(columnId, 'To Triage', fx.ownerCtx);
    expect(dto).toMatchObject({ id: columnId, name: 'To Triage' });
    const reread = await db.boardColumn.findUniqueOrThrow({ where: { id: columnId } });
    expect(reread.name).toBe('To Triage');
  });

  it('rejects an empty name with InvalidColumnNameError', async () => {
    const fx = await makeFixture('rename-empty');
    const columnId = fx.columnByStatusKey.get('todo')!;
    await expect(boardsService.renameColumn(columnId, '  ', fx.ownerCtx)).rejects.toBeInstanceOf(
      InvalidColumnNameError,
    );
  });

  it('denies a non-owner member, and 404s a cross-workspace column', async () => {
    const fx = await makeFixture('rename-gate');
    const other = await makeFixture('rename-gate-b');
    const columnId = fx.columnByStatusKey.get('todo')!;
    await expect(boardsService.renameColumn(columnId, 'X', fx.memberCtx)).rejects.toBeInstanceOf(
      NotBoardAdminError,
    );
    await expect(boardsService.renameColumn(columnId, 'X', other.ownerCtx)).rejects.toBeInstanceOf(
      BoardColumnNotFoundError,
    );
  });
});

describe('boardsService.reorderColumn (Subtask 3.6.2)', () => {
  it('moves a column to a new fractional position', async () => {
    const fx = await makeFixture('reorder');
    const cols = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    const last = cols[cols.length - 1]!;
    // move the last column to sit between the first two.
    const between = keyBetween(cols[0]!.position, cols[1]!.position);
    const dto = await boardsService.reorderColumn(last.id, between, fx.ownerCtx);
    expect(dto.position).toBe(between);

    const after = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(after[1]!.id).toBe(last.id);
  });

  it('rejects an empty position with InvalidColumnPositionError', async () => {
    const fx = await makeFixture('reorder-empty');
    const columnId = fx.columnByStatusKey.get('todo')!;
    await expect(boardsService.reorderColumn(columnId, '', fx.ownerCtx)).rejects.toBeInstanceOf(
      InvalidColumnPositionError,
    );
  });
});

describe('boardsService.deleteColumn (Subtask 3.6.2)', () => {
  it('deletes an empty column and returns its mapped status to the unmapped tray', async () => {
    const fx = await makeFixture('del-empty');
    // No work items, so the `blocked` column (maps `blocked`) is empty.
    const columnId = fx.columnByStatusKey.get('blocked')!;

    await boardsService.deleteColumn(columnId, fx.ownerCtx);

    const gone = await db.boardColumn.findUnique({ where: { id: columnId } });
    expect(gone).toBeNull();
    // its status mapping is gone → the status is unmapped now.
    const board = await boardsService.getBoard(fx.projectId, fx.ownerCtx);
    expect(board.unmappedStatuses.map((s) => s.key)).toContain('blocked');
    expect(board.columns.some((c) => c.id === columnId)).toBe(false);
  });

  it('refuses a column whose mapped status still holds cards (ColumnNotEmptyError), losing no work item', async () => {
    const fx = await makeFixture('del-busy');
    const cardId = await cardInStatus(fx, 'todo', 'Live card');
    const columnId = fx.columnByStatusKey.get('todo')!;

    await expect(boardsService.deleteColumn(columnId, fx.ownerCtx)).rejects.toBeInstanceOf(
      ColumnNotEmptyError,
    );

    // column AND work item both still exist.
    expect(await db.boardColumn.findUnique({ where: { id: columnId } })).not.toBeNull();
    expect(await db.workItem.findUnique({ where: { id: cardId } })).not.toBeNull();
  });

  it('refuses deleting the board’s last column (LastColumnError)', async () => {
    const fx = await makeFixture('del-last');
    // No work items → every column is empty and deletable. Delete down to one.
    const cols = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    for (const col of cols.slice(0, -1)) {
      await boardsService.deleteColumn(col.id, fx.ownerCtx);
    }
    const remaining = await boardColumnRepository.findByBoard(fx.boardId, fx.workspaceId);
    expect(remaining).toHaveLength(1);
    await expect(boardsService.deleteColumn(remaining[0]!.id, fx.ownerCtx)).rejects.toBeInstanceOf(
      LastColumnError,
    );
  });

  it('denies a non-owner member, and 404s a cross-workspace column', async () => {
    const fx = await makeFixture('del-gate');
    const other = await makeFixture('del-gate-b');
    const columnId = fx.columnByStatusKey.get('blocked')!;
    await expect(boardsService.deleteColumn(columnId, fx.memberCtx)).rejects.toBeInstanceOf(
      NotBoardAdminError,
    );
    await expect(boardsService.deleteColumn(columnId, other.ownerCtx)).rejects.toBeInstanceOf(
      BoardColumnNotFoundError,
    );
  });
});

describe('boardsService.mapStatusToColumn (Subtask 3.6.2)', () => {
  it('is a MOVE — a status maps to exactly one column per board (re-map replaces, never duplicates)', async () => {
    const fx = await makeFixture('map-move');
    const blockedStatusId = fx.statusIdByKey.get('blocked')!;
    const todoColumnId = fx.columnByStatusKey.get('todo')!;
    const inProgColumnId = fx.columnByStatusKey.get('in_progress')!;

    // map `blocked` into the `todo` column (away from its own column).
    const dto = await boardsService.mapStatusToColumn(
      fx.boardId,
      todoColumnId,
      blockedStatusId,
      fx.ownerCtx,
    );
    expect(dto).toMatchObject({
      boardId: fx.boardId,
      columnId: todoColumnId,
      statusId: blockedStatusId,
    });
    let rows = await db.boardColumnStatus.findMany({
      where: { boardId: fx.boardId, statusId: blockedStatusId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.columnId).toBe(todoColumnId);

    // re-map the same status to a different column → still exactly one row.
    await boardsService.mapStatusToColumn(fx.boardId, inProgColumnId, blockedStatusId, fx.ownerCtx);
    rows = await db.boardColumnStatus.findMany({
      where: { boardId: fx.boardId, statusId: blockedStatusId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.columnId).toBe(inProgColumnId);
  });

  it('maps a previously-unmapped status back onto a column', async () => {
    const fx = await makeFixture('map-unmapped');
    const statusId = fx.statusIdByKey.get('blocked')!;
    await boardsService.unmapStatus(fx.boardId, statusId, fx.ownerCtx);
    const todoColumnId = fx.columnByStatusKey.get('todo')!;
    await boardsService.mapStatusToColumn(fx.boardId, todoColumnId, statusId, fx.ownerCtx);
    const board = await boardsService.getBoard(fx.projectId, fx.ownerCtx);
    expect(board.unmappedStatuses.map((s) => s.key)).not.toContain('blocked');
  });

  it('404s a status that is not in the board’s project (WorkflowStatusNotFoundError)', async () => {
    const fx = await makeFixture('map-foreign-status');
    const other = await makeFixture('map-foreign-status-b');
    const foreignStatusId = other.statusIdByKey.get('todo')!;
    const todoColumnId = fx.columnByStatusKey.get('todo')!;
    await expect(
      boardsService.mapStatusToColumn(fx.boardId, todoColumnId, foreignStatusId, fx.ownerCtx),
    ).rejects.toBeInstanceOf(WorkflowStatusNotFoundError);
  });

  it('404s a column that belongs to another board (BoardColumnNotFoundError)', async () => {
    const fx = await makeFixture('map-foreign-col');
    const other = await makeFixture('map-foreign-col-b');
    const foreignColumnId = other.columnByStatusKey.get('todo')!;
    const statusId = fx.statusIdByKey.get('blocked')!;
    await expect(
      boardsService.mapStatusToColumn(fx.boardId, foreignColumnId, statusId, fx.ownerCtx),
    ).rejects.toBeInstanceOf(BoardColumnNotFoundError);
  });

  it('denies a non-owner member, and 404s a cross-workspace board', async () => {
    const fx = await makeFixture('map-gate');
    const other = await makeFixture('map-gate-b');
    const statusId = fx.statusIdByKey.get('blocked')!;
    const todoColumnId = fx.columnByStatusKey.get('todo')!;
    await expect(
      boardsService.mapStatusToColumn(fx.boardId, todoColumnId, statusId, fx.memberCtx),
    ).rejects.toBeInstanceOf(NotBoardAdminError);
    await expect(
      boardsService.mapStatusToColumn(fx.boardId, todoColumnId, statusId, other.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});

describe('boardsService.unmapStatus (Subtask 3.6.2)', () => {
  it('unmaps a status (it returns to the tray) without deleting work items, and is idempotent', async () => {
    const fx = await makeFixture('unmap');
    const cardId = await cardInStatus(fx, 'todo', 'Keeps existing');
    const todoStatusId = fx.statusIdByKey.get('todo')!;

    await boardsService.unmapStatus(fx.boardId, todoStatusId, fx.ownerCtx);
    let rows = await db.boardColumnStatus.findMany({
      where: { boardId: fx.boardId, statusId: todoStatusId },
    });
    expect(rows).toHaveLength(0);
    // the work item still exists (config never touches work items).
    expect(await db.workItem.findUnique({ where: { id: cardId } })).not.toBeNull();
    const board = await boardsService.getBoard(fx.projectId, fx.ownerCtx);
    expect(board.unmappedStatuses.map((s) => s.key)).toContain('todo');

    // idempotent — unmapping again is a no-op success.
    await expect(
      boardsService.unmapStatus(fx.boardId, todoStatusId, fx.ownerCtx),
    ).resolves.toBeUndefined();
    rows = await db.boardColumnStatus.findMany({
      where: { boardId: fx.boardId, statusId: todoStatusId },
    });
    expect(rows).toHaveLength(0);
  });

  it('denies a non-owner member, and 404s a cross-workspace board', async () => {
    const fx = await makeFixture('unmap-gate');
    const other = await makeFixture('unmap-gate-b');
    const statusId = fx.statusIdByKey.get('todo')!;
    await expect(
      boardsService.unmapStatus(fx.boardId, statusId, fx.memberCtx),
    ).rejects.toBeInstanceOf(NotBoardAdminError);
    await expect(
      boardsService.unmapStatus(fx.boardId, statusId, other.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});

describe('boardsService.renameBoard (Subtask 3.6.2)', () => {
  it('renames the board and persists it', async () => {
    const fx = await makeFixture('board-rename');
    const dto = await boardsService.renameBoard(fx.boardId, 'Delivery Board', fx.ownerCtx);
    expect(dto).toMatchObject({ id: fx.boardId, name: 'Delivery Board' });
    const reread = await db.board.findUniqueOrThrow({ where: { id: fx.boardId } });
    expect(reread.name).toBe('Delivery Board');
  });

  it('rejects an empty name with InvalidBoardNameError', async () => {
    const fx = await makeFixture('board-rename-empty');
    await expect(boardsService.renameBoard(fx.boardId, '   ', fx.ownerCtx)).rejects.toBeInstanceOf(
      InvalidBoardNameError,
    );
  });

  it('denies a non-owner member, and 404s a cross-workspace board', async () => {
    const fx = await makeFixture('board-rename-gate');
    const other = await makeFixture('board-rename-gate-b');
    await expect(boardsService.renameBoard(fx.boardId, 'X', fx.memberCtx)).rejects.toBeInstanceOf(
      NotBoardAdminError,
    );
    await expect(boardsService.renameBoard(fx.boardId, 'X', other.ownerCtx)).rejects.toBeInstanceOf(
      BoardNotFoundError,
    );
  });
});
