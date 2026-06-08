import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// Default-board flag + switcher ordering (Story 3.7 · Subtask 3.7.2). Real
// Postgres — runs in CI. Proves the schema change end-to-end:
//   - the seeded board (3.1.2 path) is its project's DEFAULT + carries a
//     fractional-index `position` (the create-path analogue of the migration's
//     backfill — every project keeps exactly one default board);
//   - the partial unique index `board_one_default_per_project` enforces the
//     "at most one default per project" invariant (a SECOND is_default=true for
//     the same project is rejected with a unique_violation), while a non-default
//     second board (the N-boards-per-project case) is allowed.
//
// truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
// cascades to project → board, so no dedicated board truncate is needed.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeWorkspaceAndUser(
  label = 'board-flag',
): Promise<{ userId: string; workspaceId: string }> {
  const user = await usersService.createUser({
    email: `${label}@example.com`,
    password: 'hunter2hunter2',
    name: `Board Flag ${label}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Board Flag WS ${label}`,
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: ws.workspace.id };
}

describe('board.isDefault + board.position (Subtask 3.7.2)', () => {
  it('the seeded board is the project default and carries the first position', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Defaulted',
    });

    const boards = await db.board.findMany({ where: { projectId: project.id } });
    expect(boards).toHaveLength(1);
    expect(boards[0]?.isDefault).toBe(true);
    // `keyForAppend(null)` mints the first fractional-index key — the same value
    // the migration backfills onto pre-3.7 boards.
    expect(boards[0]?.position).toBe('a0');
  });

  it('rejects a SECOND default board for the same project (partial unique index)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'OneDefault',
    });
    // The seeded board is already the project's default; a second is_default=true
    // for the same project violates `board_one_default_per_project`.
    await expect(
      db.board.create({
        data: {
          workspaceId,
          projectId: project.id,
          name: 'Second Default',
          type: 'kanban',
          position: 'a1',
          isDefault: true,
        },
      }),
    ).rejects.toThrow();
  });

  it('allows additional NON-default boards (N boards, one default)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'ManyBoards',
    });

    await db.board.create({
      data: {
        workspaceId,
        projectId: project.id,
        name: 'Triage',
        type: 'kanban',
        position: 'a1',
        isDefault: false,
      },
    });

    const boards = await db.board.findMany({
      where: { projectId: project.id },
      orderBy: { position: 'asc' },
    });
    expect(boards).toHaveLength(2);
    expect(boards.filter((b) => b.isDefault)).toHaveLength(1);
    // Switcher order follows `position`.
    expect(boards.map((b) => b.name)).toEqual(['Board', 'Triage']);
  });

  it('lets two DIFFERENT projects each keep their own default (partial index is per-project)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const a = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'ProjA',
    });
    const b = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'ProjB',
    });

    const aDefault = await db.board.count({ where: { projectId: a.id, isDefault: true } });
    const bDefault = await db.board.count({ where: { projectId: b.id, isDefault: true } });
    expect(aDefault).toBe(1);
    expect(bDefault).toBe(1);
  });
});
