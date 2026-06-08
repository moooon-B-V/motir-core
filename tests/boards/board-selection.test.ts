import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { boardsService } from '@/lib/services/boardsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { BoardNotFoundError } from '@/lib/boards/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// boardsService.getBoard — BOARD SELECTION (Story 3.7 · Subtask 3.7.5). The read
// path now resolves WHICH board to project: an explicit `boardId` (the page's
// `?board=` selection) or, when absent, the project's DEFAULT board (`isDefault`
// — NOT "the oldest board"). A selected id must belong to the active project AND
// workspace, else a tenant-safe 404. Real Postgres (no mocks), per CLAUDE.md;
// createTestProject auto-seeds the default board ("Board", isDefault, a0) with
// one column per workflow status (3.1.2), so each fixture starts one-board.

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
  /** The auto-seeded default board ("Board", isDefault, a0). */
  defaultBoardId: string;
}

async function makeFixture(label: string): Promise<Fixture> {
  const user = await usersService.createUser({
    email: `board-select-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Select User',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Select WS ${label}`,
    ownerUserId: user.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: user.id });
  const board = await boardRepository.findDefaultForProject(project.id, workspaceId);
  if (!board) throw new Error('expected a seeded default board');
  return {
    ctx: { userId: user.id, workspaceId },
    workspaceId,
    projectId: project.id,
    defaultBoardId: board.id,
  };
}

describe('boardsService.getBoard — board selection (Subtask 3.7.5)', () => {
  it('projects the SELECTED board, with each board carrying its own config', async () => {
    const fx = await makeFixture('own-config');
    const second = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ctx);

    // Give the two boards DIFFERENT swimlane group-by config.
    await boardsService.setSwimlaneGroupBy(fx.defaultBoardId, 'assignee', fx.ctx);
    await boardsService.setSwimlaneGroupBy(second.id, 'priority', fx.ctx);

    const a = await boardsService.getBoard(fx.projectId, fx.ctx, fx.defaultBoardId);
    const b = await boardsService.getBoard(fx.projectId, fx.ctx, second.id);

    // Each read returns ITS board's identity + ITS own config — not the other's.
    expect(a.boardId).toBe(fx.defaultBoardId);
    expect(a.name).toBe('Board');
    expect(a.swimlaneGroupBy).toBe('assignee');

    expect(b.boardId).toBe(second.id);
    expect(b.name).toBe('Triage');
    expect(b.swimlaneGroupBy).toBe('priority');
  });

  it('falls back to the project DEFAULT board when no boardId is given', async () => {
    const fx = await makeFixture('default-fallback');
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.boardId).toBe(fx.defaultBoardId);
  });

  it('the default fallback follows isDefault (the PROMOTED board), not the oldest', async () => {
    const fx = await makeFixture('promoted-default');
    const second = await boardsService.createBoard(fx.projectId, { name: 'Triage' }, fx.ctx);
    // Promote the NEWER board to default — the older auto-seeded board is no
    // longer the default. The no-`boardId` read must follow the flag, not age.
    await boardsService.setDefaultBoard(second.id, fx.ctx);

    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.boardId).toBe(second.id);
    expect(board.boardId).not.toBe(fx.defaultBoardId);
  });

  it('404s a boardId from another PROJECT in the same workspace (never cross-project)', async () => {
    const fx = await makeFixture('cross-project');
    // A second project in the SAME workspace, with its own default board.
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ctx.userId,
    });
    const otherBoard = await boardRepository.findDefaultForProject(other.id, fx.workspaceId);
    if (!otherBoard) throw new Error('expected a seeded default board');

    await expect(
      boardsService.getBoard(fx.projectId, fx.ctx, otherBoard.id),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });

  it('404s a boardId from another WORKSPACE (tenant-safe)', async () => {
    const a = await makeFixture('tenant-a');
    const b = await makeFixture('tenant-b');

    // A's context naming B's board id — the workspace-scoped repo read returns
    // null, so it 404s (no cross-tenant existence leak).
    await expect(
      boardsService.getBoard(a.projectId, a.ctx, b.defaultBoardId),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });

  it('404s an unknown boardId', async () => {
    const fx = await makeFixture('unknown');
    await expect(
      boardsService.getBoard(fx.projectId, fx.ctx, 'brd_does_not_exist'),
    ).rejects.toBeInstanceOf(BoardNotFoundError);
  });
});
