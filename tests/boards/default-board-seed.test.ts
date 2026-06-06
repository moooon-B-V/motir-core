import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { boardsService } from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../helpers/db';

// Default-board seed (Story 3.1 · Subtask 3.1.2). Real Postgres — runs in CI.
// Proves the board seed wired into createProject (same transaction → atomic
// with the project + workflow), the column-from-workflow projection (one column
// per status, in workflow order, each mapped to its status), and the
// idempotent one-off backfill.
//
// truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
// cascades to project → board / board_column / board_column_status, so no
// dedicated board truncate is needed.

const WORKFLOW_ORDER = ['To Do', 'Blocked', 'In Progress', 'In Review', 'Done', 'Cancelled'];

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeWorkspaceAndUser(
  label = 'board-seed',
): Promise<{ userId: string; workspaceId: string }> {
  const user = await usersService.createUser({
    email: `${label}@example.com`,
    password: 'hunter2hunter2',
    name: `Board Seed ${label}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Board Seed WS ${label}`,
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: ws.workspace.id };
}

describe('createProject seeds the default board (same transaction)', () => {
  it('a fresh project ends with exactly one Kanban board named "Board"', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Boarded',
    });

    const boards = await db.board.findMany({ where: { projectId: project.id } });
    expect(boards).toHaveLength(1);
    expect(boards[0]?.name).toBe('Board');
    expect(boards[0]?.type).toBe('kanban');
    expect(boards[0]?.workspaceId).toBe(workspaceId);
  });

  it('seeds six columns in workflow order, each mapped 1:1 to its status', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Columns',
    });

    const board = await db.board.findFirstOrThrow({ where: { projectId: project.id } });
    const columns = await db.boardColumn.findMany({
      where: { boardId: board.id },
      orderBy: { position: 'asc' },
    });
    expect(columns.map((c) => c.name)).toEqual(WORKFLOW_ORDER);

    // Column positions mirror the workflow-status positions (same order).
    const statuses = await db.workflowStatus.findMany({
      where: { projectId: project.id },
      orderBy: { position: 'asc' },
    });
    expect(columns.map((c) => c.position)).toEqual(statuses.map((s) => s.position));

    // Exactly one mapping per column, pointing at the same-labelled status.
    const mappings = await db.boardColumnStatus.findMany({ where: { boardId: board.id } });
    expect(mappings).toHaveLength(6);

    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const columnById = new Map(columns.map((c) => [c.id, c]));
    for (const m of mappings) {
      expect(m.workspaceId).toBe(workspaceId);
      // The default is 1:1: the mapped status's label equals its column's name.
      expect(statusById.get(m.statusId)?.label).toBe(columnById.get(m.columnId)?.name);
    }
    // Every status is mapped exactly once (no unmapped status in the default).
    expect(new Set(mappings.map((m) => m.statusId)).size).toBe(6);
    expect(new Set(mappings.map((m) => m.columnId)).size).toBe(6);
  });

  it('does not leak the board into another project in the same workspace', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const a = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Alpha',
    });
    const b = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Beta',
    });
    expect(await db.board.count({ where: { projectId: a.id } })).toBe(1);
    expect(await db.board.count({ where: { projectId: b.id } })).toBe(1);
    // Each board's columns belong only to that project.
    const aBoard = await db.board.findFirstOrThrow({ where: { projectId: a.id } });
    const aCols = await db.boardColumn.findMany({ where: { boardId: aBoard.id } });
    expect(aCols.every((c) => c.projectId === a.id)).toBe(true);
  });
});

describe('boardsService.backfillDefaultBoard (one-off, idempotent)', () => {
  it('seeds a board for a board-less project, then no-ops on a second call', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    // A project WITH its workflow but no board — mimics a project predating
    // this Story. Build it via createProject (so it has the six statuses), then
    // drop its board (cascades to columns + mappings).
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Predates',
    });
    await db.board.deleteMany({ where: { projectId: project.id } });
    expect(await db.board.count({ where: { projectId: project.id } })).toBe(0);

    const seeded = await boardsService.backfillDefaultBoard(project.id, userId);
    expect(seeded).toBe(true);
    expect(await db.board.count({ where: { projectId: project.id } })).toBe(1);
    expect(await db.boardColumn.count({ where: { projectId: project.id } })).toBe(6);
    expect(await db.boardColumnStatus.count({ where: { projectId: project.id } })).toBe(6);

    // Idempotent — already has a board, so the second call is a no-op and adds
    // no duplicate board/columns.
    const again = await boardsService.backfillDefaultBoard(project.id, userId);
    expect(again).toBe(false);
    expect(await db.board.count({ where: { projectId: project.id } })).toBe(1);
    expect(await db.boardColumn.count({ where: { projectId: project.id } })).toBe(6);
  });

  it('leaves an already-boarded project untouched (no second board)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'AlreadyBoarded',
    });
    const seeded = await boardsService.backfillDefaultBoard(project.id, userId);
    expect(seeded).toBe(false);
    expect(await db.board.count({ where: { projectId: project.id } })).toBe(1);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    const { userId } = await makeWorkspaceAndUser();
    await expect(
      boardsService.backfillDefaultBoard('nonexistent-id', userId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
