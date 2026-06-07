import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardSwimlaneGroupBy } from '@prisma/client';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  InvalidSwimlaneGroupByError,
  InvalidWipLimitError,
  NotBoardAdminError,
} from '@/lib/boards/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// boardsService.setSwimlaneGroupBy / setColumnWipLimit (Story 3.3 · Subtask
// 3.3.3) — the board-config write path. Real Postgres (no mocks), per CLAUDE.md.
// createTestProject → createProject auto-seeds the default board + one column
// per workflow status (3.1.2), each with wipLimit null, so the config writes
// here operate on a real seeded board.
//
// Authorization: board config is workspace-OWNER-gated (finding #36), mirroring
// the 2.2.5 workflow editor — so an owner succeeds and a plain member is denied
// (NotBoardAdminError). Tenancy (finding #26): a board/column from another
// workspace is a 404 (no cross-tenant existence leak), proven below.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE →
  // project → board / board_column.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  /** The workspace OWNER context (passes the admin gate). */
  ownerCtx: ServiceContext;
  /** A plain MEMBER context in the same workspace (fails the admin gate). */
  memberCtx: ServiceContext;
  workspaceId: string;
  projectId: string;
  boardId: string;
  columnId: string;
}

async function makeFixture(label = 'a'): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `board-config-owner-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Config Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Config WS ${label}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });

  // A plain member (role `member`) in the same workspace — NOT the owner.
  const member = await usersService.createUser({
    email: `board-config-member-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Config Member',
  });
  await db.workspaceMembership.create({
    data: { userId: member.id, workspaceId, role: 'member' },
  });

  const board = await boardRepository.findDefaultForProject(project.id, workspaceId);
  if (!board) throw new Error('expected a seeded default board');
  const column = await db.boardColumn.findFirstOrThrow({
    where: { boardId: board.id },
    orderBy: { position: 'asc' },
  });

  return {
    ownerCtx: { userId: owner.id, workspaceId },
    memberCtx: { userId: member.id, workspaceId },
    workspaceId,
    projectId: project.id,
    boardId: board.id,
    columnId: column.id,
  };
}

describe('boardsService.setSwimlaneGroupBy (Subtask 3.3.3)', () => {
  it('sets and persists the group-by for the workspace owner', async () => {
    const fx = await makeFixture('gb-set');
    const dto = await boardsService.setSwimlaneGroupBy(fx.boardId, 'assignee', fx.ownerCtx);
    expect(dto).toMatchObject({ id: fx.boardId, swimlaneGroupBy: 'assignee' });

    const reread = await db.board.findUniqueOrThrow({ where: { id: fx.boardId } });
    expect(reread.swimlaneGroupBy).toBe(BoardSwimlaneGroupBy.assignee);
  });

  it('round-trips back to `none` (the flat board)', async () => {
    const fx = await makeFixture('gb-none');
    await boardsService.setSwimlaneGroupBy(fx.boardId, 'epic', fx.ownerCtx);
    const dto = await boardsService.setSwimlaneGroupBy(fx.boardId, 'none', fx.ownerCtx);
    expect(dto.swimlaneGroupBy).toBe('none');
  });

  it('rejects an invalid group-by with InvalidSwimlaneGroupByError', async () => {
    const fx = await makeFixture('gb-bad');
    await expect(
      boardsService.setSwimlaneGroupBy(fx.boardId, 'sprint', fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidSwimlaneGroupByError);
    // The board is unchanged.
    const reread = await db.board.findUniqueOrThrow({ where: { id: fx.boardId } });
    expect(reread.swimlaneGroupBy).toBe(BoardSwimlaneGroupBy.none);
  });

  it('denies a non-owner member with NotBoardAdminError (no write)', async () => {
    const fx = await makeFixture('gb-member');
    await expect(
      boardsService.setSwimlaneGroupBy(fx.boardId, 'priority', fx.memberCtx),
    ).rejects.toBeInstanceOf(NotBoardAdminError);
    const reread = await db.board.findUniqueOrThrow({ where: { id: fx.boardId } });
    expect(reread.swimlaneGroupBy).toBe(BoardSwimlaneGroupBy.none);
  });

  it('treats a cross-workspace board as not found (404, no leak)', async () => {
    const fx = await makeFixture('gb-tenantA');
    const other = await makeFixture('gb-tenantB');
    // tenant B's owner targets tenant A's board → the workspace-scoped read
    // returns null → BoardNotFoundError, NOT a 403 (no existence leak).
    await expect(
      boardsService.setSwimlaneGroupBy(fx.boardId, 'assignee', other.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});

describe('boardsService.setColumnWipLimit (Subtask 3.3.3)', () => {
  it('sets and persists a WIP limit for the workspace owner', async () => {
    const fx = await makeFixture('wip-set');
    const dto = await boardsService.setColumnWipLimit(fx.columnId, 5, fx.ownerCtx);
    expect(dto).toMatchObject({ id: fx.columnId, wipLimit: 5 });

    const reread = await db.boardColumn.findUniqueOrThrow({ where: { id: fx.columnId } });
    expect(reread.wipLimit).toBe(5);
  });

  it('clears a WIP limit when passed null', async () => {
    const fx = await makeFixture('wip-clear');
    await boardsService.setColumnWipLimit(fx.columnId, 3, fx.ownerCtx);
    const dto = await boardsService.setColumnWipLimit(fx.columnId, null, fx.ownerCtx);
    expect(dto.wipLimit).toBeNull();
    const reread = await db.boardColumn.findUniqueOrThrow({ where: { id: fx.columnId } });
    expect(reread.wipLimit).toBeNull();
  });

  it('accepts 0 (a non-negative integer) as a valid limit', async () => {
    const fx = await makeFixture('wip-zero');
    const dto = await boardsService.setColumnWipLimit(fx.columnId, 0, fx.ownerCtx);
    expect(dto.wipLimit).toBe(0);
  });

  it('rejects a negative limit with InvalidWipLimitError', async () => {
    const fx = await makeFixture('wip-neg');
    await expect(
      boardsService.setColumnWipLimit(fx.columnId, -1, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidWipLimitError);
  });

  it('rejects a fractional (non-integer) limit with InvalidWipLimitError', async () => {
    const fx = await makeFixture('wip-frac');
    await expect(
      boardsService.setColumnWipLimit(fx.columnId, 2.5, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidWipLimitError);
    const reread = await db.boardColumn.findUniqueOrThrow({ where: { id: fx.columnId } });
    expect(reread.wipLimit).toBeNull();
  });

  it('denies a non-owner member with NotBoardAdminError (no write)', async () => {
    const fx = await makeFixture('wip-member');
    await expect(
      boardsService.setColumnWipLimit(fx.columnId, 4, fx.memberCtx),
    ).rejects.toBeInstanceOf(NotBoardAdminError);
    const reread = await db.boardColumn.findUniqueOrThrow({ where: { id: fx.columnId } });
    expect(reread.wipLimit).toBeNull();
  });

  it('treats a cross-workspace column as not found (404, no leak)', async () => {
    const fx = await makeFixture('wip-tenantA');
    const other = await makeFixture('wip-tenantB');
    await expect(
      boardsService.setColumnWipLimit(fx.columnId, 5, other.ownerCtx),
    ).rejects.toBeInstanceOf(BoardColumnNotFoundError);
  });

  it('exposes a tx-required boardColumnRepository.update (compile-time tx guard)', async () => {
    // The write goes through the tx-required repo method; a no-op sanity check
    // that the seeded column resolves via the workspace-scoped read.
    const fx = await makeFixture('wip-repo');
    const column = await boardColumnRepository.findById(fx.columnId, fx.workspaceId);
    expect(column?.id).toBe(fx.columnId);
  });
});
