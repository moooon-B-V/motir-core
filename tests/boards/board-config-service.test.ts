import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BoardSwimlaneGroupBy } from '@/lib/generated/prisma/client';
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
} from '@/lib/boards/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
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
// (PermissionDeniedError). Tenancy (finding #26): a board/column from another
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

  it('denies a non-owner member with PermissionDeniedError (no write)', async () => {
    const fx = await makeFixture('gb-member');
    await expect(
      boardsService.setSwimlaneGroupBy(fx.boardId, 'priority', fx.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
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

  it('denies a non-owner member with PermissionDeniedError (no write)', async () => {
    const fx = await makeFixture('wip-member');
    await expect(
      boardsService.setColumnWipLimit(fx.columnId, 4, fx.memberCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
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

describe('the MOTIR-2296 WIDENING — who may configure a board, before and after', () => {
  // The card this suite belongs to LOOSENS the gate, and that is the assertion
  // most worth writing down. Board configuration was `assertBoardConfigAdmin` →
  // `isOwnerRole(...)`: the workspace OWNER and nobody else. Not a workspace
  // admin, not the project's own admin. `board:configure` is held by all three,
  // so a project admin can now tune their own board — which is the whole reason
  // the key exists, and what both mirrors do.
  //
  // Stating it as a test rather than a comment is the point: a PR that reads as
  // a refactor while handing board configuration to a new class of actor is
  // exactly the change that gets discovered later, by someone surprised.

  async function actorWithRoles(
    fx: Awaited<ReturnType<typeof makeFixture>>,
    label: string,
    roles: { workspaceRole?: 'admin' | 'member'; projectRole?: 'admin' | 'member' | 'viewer' },
  ): Promise<ServiceContext> {
    const user = await usersService.createUser({
      email: `board-widen-${label}@example.com`,
      password: 'hunter2hunter2',
      name: label,
    });
    await db.workspaceMembership.create({
      data: { userId: user.id, workspaceId: fx.workspaceId, role: roles.workspaceRole ?? 'member' },
    });
    if (roles.projectRole) {
      await db.projectMembership.create({
        data: {
          userId: user.id,
          projectId: fx.projectId,
          workspaceId: fx.workspaceId,
          role: roles.projectRole,
        },
      });
    }
    return { userId: user.id, workspaceId: fx.workspaceId };
  }

  it('a PROJECT ADMIN can now configure the board — the capability this card grants', async () => {
    const fx = await makeFixture('widen-proj-admin');
    const ctx = await actorWithRoles(fx, 'proj-admin', { projectRole: 'admin' });

    const dto = await boardsService.setSwimlaneGroupBy(fx.boardId, 'priority', ctx);
    expect(dto.swimlaneGroupBy).toBe('priority');
    const column = await boardsService.addColumn(fx.boardId, { name: 'Triage' }, ctx);
    expect(column.name).toBe('Triage');
  });

  it('a WORKSPACE ADMIN can too — they could not under the workspace-OWNER gate either', async () => {
    const fx = await makeFixture('widen-ws-admin');
    const ctx = await actorWithRoles(fx, 'ws-admin', { workspaceRole: 'admin' });

    const dto = await boardsService.setSwimlaneGroupBy(fx.boardId, 'assignee', ctx);
    expect(dto.swimlaneGroupBy).toBe('assignee');
  });

  it('a project MEMBER and a VIEWER are still refused, and told which key is missing', async () => {
    const fx = await makeFixture('widen-denied');
    for (const role of ['member', 'viewer'] as const) {
      const ctx = await actorWithRoles(fx, `denied-${role}`, { projectRole: role });
      const err = await boardsService
        .addColumn(fx.boardId, { name: 'Nope' }, ctx)
        .catch((e: unknown) => e);
      expect(err, `a project ${role} must not configure the board`).toBeInstanceOf(
        PermissionDeniedError,
      );
      expect((err as PermissionDeniedError).permission).toBe('board:configure');
    }
  });

  it('a project member can still MOVE a card and still READ the board', async () => {
    // The regression this card is most likely to cause. Dragging a card between
    // columns is `work_item:edit` and is deliberately untouched; so is the board
    // projection read.
    const fx = await makeFixture('widen-move');
    const ctx = await actorWithRoles(fx, 'mover', { projectRole: 'member' });

    const board = await boardsService.getBoard(fx.projectId, ctx);
    expect(board.columns.length).toBeGreaterThan(0);
    const held = await projectAccessService.getPermissions(fx.projectId, ctx);
    expect(held.has('work_item:edit')).toBe(true);
    expect(held.has('board:configure')).toBe(false);
  });
});
