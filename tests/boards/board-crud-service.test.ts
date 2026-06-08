import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { boardColumnRepository } from '@/lib/repositories/boardColumnRepository';
import { boardColumnStatusRepository } from '@/lib/repositories/boardColumnStatusRepository';
import {
  BoardNotFoundError,
  InvalidBoardNameError,
  InvalidBoardTypeError,
  LastBoardError,
  NotBoardAdminError,
} from '@/lib/boards/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// boardsService board LIFECYCLE — multiple boards per project (Story 3.7 ·
// Subtask 3.7.3): createBoard (seed columns) / listBoards / setDefaultBoard /
// deleteBoard + the guards. Real Postgres (no mocks), per CLAUDE.md.
// createTestProject auto-seeds the DEFAULT board ("Board", isDefault, position
// a0) with one column per workflow status (3.1.2), so every fixture starts as a
// real one-board project.
//
// Authorization: board CRUD is a project-config write → workspace-OWNER-gated
// (finding #36 + the consistent build over the 3.7.3 card's "membership-gated"
// prose), so an owner succeeds and a plain member is denied (NotBoardAdminError).
// Tenancy (finding #26): a board/project from another workspace is a 404 (no
// cross-tenant existence leak).

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE →
  // project → board / board_column / board_column_status / work_item.
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
  /** The auto-seeded default board ("Board", isDefault, a0). */
  defaultBoardId: string;
}

async function makeFixture(label = 'a'): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `board-crud-owner-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'CRUD Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `CRUD WS ${label}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });

  const member = await usersService.createUser({
    email: `board-crud-member-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'CRUD Member',
  });
  await db.workspaceMembership.create({
    data: { userId: member.id, workspaceId, role: 'member' },
  });

  const board = await boardRepository.findDefaultForProject(project.id, workspaceId);
  if (!board) throw new Error('expected a seeded default board');

  return {
    ownerCtx: { userId: owner.id, workspaceId },
    memberCtx: { userId: member.id, workspaceId },
    workspaceId,
    projectId: project.id,
    defaultBoardId: board.id,
  };
}

describe('boardsService.createBoard (Subtask 3.7.3)', () => {
  it('creates a NON-default board with default columns seeded off the workflow', async () => {
    const fx = await makeFixture('create');
    const defaultCols = await boardColumnRepository.findByBoard(fx.defaultBoardId, fx.workspaceId);

    const created = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);

    expect(created).toMatchObject({ name: 'Triage', type: 'kanban', isDefault: false });
    // Appended after the default board's a0 position.
    expect(created.position > 'a0').toBe(true);

    // It seeded one column per workflow status (same shape as the default board),
    // each mapped to exactly one status.
    const cols = await boardColumnRepository.findByBoard(created.id, fx.workspaceId);
    expect(cols).toHaveLength(defaultCols.length);
    expect(defaultCols.length).toBeGreaterThan(0);
    const mappings = await boardColumnStatusRepository.findByBoard(created.id, fx.workspaceId);
    expect(mappings).toHaveLength(cols.length);

    // The project's default is unchanged (still exactly one default).
    const defaults = await db.board.count({ where: { projectId: fx.projectId, isDefault: true } });
    expect(defaults).toBe(1);
  });

  it('accepts an explicit scrum type (the shipped enum, rung 2 — UI is Kanban-only)', async () => {
    const fx = await makeFixture('scrum');
    const created = await boardsService.createBoard(
      fx.projectId,
      { name: 'Sprint board', type: 'scrum' },
      fx.ownerCtx,
    );
    expect(created.type).toBe('scrum');
  });

  it('rejects an empty name (400) and an invalid type (400)', async () => {
    const fx = await makeFixture('invalid');
    await expect(
      boardsService.createBoard(fx.projectId, { name: '   ' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidBoardNameError);
    await expect(
      boardsService.createBoard(fx.projectId, { name: 'X', type: 'gantt' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidBoardTypeError);
  });

  it('denies a plain member (403) and a cross-workspace project (404)', async () => {
    const fx = await makeFixture('authz');
    await expect(
      boardsService.createBoard(fx.projectId, { name: 'Nope' }, fx.memberCtx),
    ).rejects.toBeInstanceOf(NotBoardAdminError);

    // A project in ANOTHER workspace, addressed with this owner's context → 404.
    const other = await makeFixture('authz-other');
    await expect(
      boardsService.createBoard(other.projectId, { name: 'Cross' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('boardsService.listBoards (Subtask 3.7.3)', () => {
  it('lists the project boards in switcher (position) order', async () => {
    const fx = await makeFixture('list');
    await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);

    const boards = await boardsService.listBoards(fx.projectId, fx.memberCtx); // a member may read
    expect(boards.map((b) => b.name)).toEqual(['Board', 'Triage']);
    expect(boards[0]).toMatchObject({ isDefault: true });
    expect(boards[1]).toMatchObject({ isDefault: false });
  });
});

describe('boardsService.setDefaultBoard (Subtask 3.7.3)', () => {
  it('promotes a board to default and clears the prior default (one-default invariant)', async () => {
    const fx = await makeFixture('setdefault');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);

    const updated = await boardsService.setDefaultBoard(triage.id, fx.ownerCtx);
    expect(updated).toMatchObject({ id: triage.id, isDefault: true });

    const rows = await db.board.findMany({ where: { projectId: fx.projectId } });
    expect(rows.filter((b) => b.isDefault)).toHaveLength(1);
    expect(rows.find((b) => b.id === triage.id)?.isDefault).toBe(true);
    expect(rows.find((b) => b.id === fx.defaultBoardId)?.isDefault).toBe(false);
  });

  it('is a no-op when the board is already the default', async () => {
    const fx = await makeFixture('setdefault-noop');
    const updated = await boardsService.setDefaultBoard(fx.defaultBoardId, fx.ownerCtx);
    expect(updated).toMatchObject({ id: fx.defaultBoardId, isDefault: true });
    const defaults = await db.board.count({ where: { projectId: fx.projectId, isDefault: true } });
    expect(defaults).toBe(1);
  });

  it('denies a member (403) and 404s a cross-workspace board', async () => {
    const fx = await makeFixture('setdefault-authz');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    await expect(boardsService.setDefaultBoard(triage.id, fx.memberCtx)).rejects.toBeInstanceOf(
      NotBoardAdminError,
    );

    const other = await makeFixture('setdefault-other');
    await expect(
      boardsService.setDefaultBoard(other.defaultBoardId, fx.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});

describe('boardsService.deleteBoard (Subtask 3.7.3)', () => {
  it('deletes a non-default board + its columns/config, leaving the project issues intact', async () => {
    const fx = await makeFixture('delete');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    // A real issue on the project (belongs to the project, never a board).
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Survives a board delete' },
      fx.ownerCtx,
    );

    await boardsService.deleteBoard(triage.id, fx.ownerCtx);

    // The board + its column/config rows are gone (FK cascade)…
    expect(await boardRepository.findById(triage.id, fx.workspaceId)).toBeNull();
    expect(await boardColumnRepository.findByBoard(triage.id, fx.workspaceId)).toHaveLength(0);
    expect(await boardColumnStatusRepository.findByBoard(triage.id, fx.workspaceId)).toHaveLength(
      0,
    );
    // …the issue survives, and the default board is untouched.
    expect(await db.workItem.findUnique({ where: { id: item.id } })).not.toBeNull();
    const remaining = await db.board.findMany({ where: { projectId: fx.projectId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(fx.defaultBoardId);
    expect(remaining[0]?.isDefault).toBe(true);
  });

  it('promotes the next board (by position) to default when the default is deleted', async () => {
    const fx = await makeFixture('delete-default');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    // Make Triage the default, so deleting it must promote the original Board.
    await boardsService.setDefaultBoard(triage.id, fx.ownerCtx);

    await boardsService.deleteBoard(triage.id, fx.ownerCtx);

    const rows = await db.board.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(fx.defaultBoardId);
    expect(rows[0]?.isDefault).toBe(true); // promoted — never a project with no default
  });

  it('refuses to delete the LAST board (409 LastBoardError)', async () => {
    const fx = await makeFixture('delete-last');
    await expect(boardsService.deleteBoard(fx.defaultBoardId, fx.ownerCtx)).rejects.toBeInstanceOf(
      LastBoardError,
    );
    // Still there.
    expect(await boardRepository.findById(fx.defaultBoardId, fx.workspaceId)).not.toBeNull();
  });

  it('denies a member (403) and 404s a cross-workspace board', async () => {
    const fx = await makeFixture('delete-authz');
    const triage = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ownerCtx);
    await expect(boardsService.deleteBoard(triage.id, fx.memberCtx)).rejects.toBeInstanceOf(
      NotBoardAdminError,
    );

    const other = await makeFixture('delete-other');
    await expect(
      boardsService.deleteBoard(other.defaultBoardId, fx.ownerCtx),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});
