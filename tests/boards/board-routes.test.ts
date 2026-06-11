import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectContext } from '@/lib/projects';
import type { BoardProjectionDto } from '@/lib/dto/boards';

// Board API routes (Story 3.1 · Subtask 3.1.6). Real Postgres; we stub only the
// two session/context resolvers the test env can't supply via cookies
// (getSession, getActiveProject) — every DB read/write goes through the real
// service → repo → Prisma chain. This asserts the TRANSPORT contract (status
// codes + the typed-error → HTTP mapping); the projection/move behaviour itself
// is covered by 3.1.4 / 3.1.5.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

// Import AFTER the mocks are registered.
const { GET: boardGET, PATCH: boardPATCH } = await import('@/app/api/board/route');
const { PATCH: columnPATCH } = await import('@/app/api/board/columns/[columnId]/route');
const { POST: movePOST } = await import('@/app/api/board/move/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
  // Stub the Inngest publish: a cross-column move now emits
  // `work-item/transitioned` post-commit (Subtask 5.4.5), and the test env
  // has no Inngest key (the comments-suite pattern).
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'board-routes@example.com',
    password: 'hunter2hunter2',
    name: 'Board Owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Board WS', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Board Demo',
    identifier: 'BRD',
  });
  const fx = { userId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
  session.current = {
    user: { id: owner.id, email: 'board-routes@example.com', name: 'Board Owner' },
  };
  activeCtx.current = { ...fx, project };
  return fx;
}

function moveReq(body: unknown) {
  return movePOST(
    new Request(`${BASE}/api/board/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// GET /api/board now reads a `?boardId=` selection (Subtask 3.7.5), so the
// handler needs a real Request. `query` lets a test target a specific board;
// omitted → the project's default board (the pre-3.7 behaviour).
function boardGetReq(query = '') {
  return boardGET(new Request(`${BASE}/api/board${query}`));
}

function boardPatchReq(body: unknown) {
  return boardPATCH(
    new Request(`${BASE}/api/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function columnPatchReq(columnId: string, body: unknown) {
  return columnPATCH(
    new Request(`${BASE}/api/board/columns/${columnId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ columnId }) },
  );
}

describe('board API routes', () => {
  it('GET /api/board → 401 without a session', async () => {
    session.current = null;
    const res = await boardGetReq();
    expect(res.status).toBe(401);
  });

  it('GET /api/board → the projection for the active project', async () => {
    await makeFixture();
    const res = await boardGetReq();
    expect(res.status).toBe(200);
    const board = (await res.json()) as BoardProjectionDto;
    expect(board.columns.map((c) => c.statusKeys[0])).toEqual([
      'todo',
      'blocked',
      'in_progress',
      'in_review',
      'done',
      'cancelled',
    ]);
  });

  it('GET /api/board?boardId= → the SELECTED board (Subtask 3.7.5)', async () => {
    const fx = await makeFixture();
    const triage = await boardsService.createBoard(
      fx.projectId,
      { name: 'Triage' },
      {
        userId: fx.userId,
        workspaceId: fx.workspaceId,
      },
    );

    const res = await boardGetReq(`?boardId=${triage.id}`);
    expect(res.status).toBe(200);
    const board = (await res.json()) as BoardProjectionDto;
    expect(board.boardId).toBe(triage.id);
    expect(board.name).toBe('Triage');
  });

  it('GET /api/board?boardId= → 404 for a board outside the active project/workspace', async () => {
    await makeFixture();
    const res = await boardGetReq('?boardId=brd_not_a_real_board');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('BOARD_NOT_FOUND');
  });

  it('POST /api/board/move → 200 for a legal cross-column move (status persists)', async () => {
    const fx = await makeFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'movable' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );
    const board = (await (await boardGetReq()).json()) as BoardProjectionDto;
    const inProgress = board.columns.find((c) => c.statusKeys[0] === 'in_progress')!;

    const res = await moveReq({
      boardId: board.boardId,
      workItemId: card.id,
      toColumnId: inProgress.id,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { appliedStatus: string }).appliedStatus).toBe('in_progress');
  });

  it('POST /api/board/move → 409 for an illegal transition (the snap-back signal)', async () => {
    const fx = await makeFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'cannot reach done' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );
    const board = (await (await boardGetReq()).json()) as BoardProjectionDto;
    const done = board.columns.find((c) => c.statusKeys[0] === 'done')!;

    // todo → done is NOT a legal transition in the default restricted workflow.
    const res = await moveReq({ boardId: board.boardId, workItemId: card.id, toColumnId: done.id });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ILLEGAL_BOARD_MOVE');
  });

  it('POST /api/board/move → 400 when required fields are missing', async () => {
    await makeFixture();
    const res = await moveReq({ workItemId: 'x' }); // no boardId / toColumnId
    expect(res.status).toBe(400);
  });
});

// Board CONFIG routes (Subtask 3.3.3) — PATCH /api/board (swimlane group-by) +
// PATCH /api/board/columns/[columnId] (WIP limit). Transport contract only; the
// validation/authorization behaviour itself is covered in board-config-service.
describe('board config API routes (Subtask 3.3.3)', () => {
  async function firstColumnId(boardId: string): Promise<string> {
    const col = await db.boardColumn.findFirstOrThrow({
      where: { boardId },
      orderBy: { position: 'asc' },
    });
    return col.id;
  }

  async function boardId(): Promise<string> {
    return ((await (await boardGetReq()).json()) as BoardProjectionDto).boardId;
  }

  it('PATCH /api/board → 401 without a session', async () => {
    session.current = null;
    const res = await boardPatchReq({ boardId: 'x', swimlaneGroupBy: 'assignee' });
    expect(res.status).toBe(401);
  });

  it('PATCH /api/board → 200 sets the group-by for the owner', async () => {
    await makeFixture();
    const res = await boardPatchReq({ boardId: await boardId(), swimlaneGroupBy: 'assignee' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { swimlaneGroupBy: string }).swimlaneGroupBy).toBe('assignee');
  });

  it('PATCH /api/board → 400 for an invalid group-by value', async () => {
    await makeFixture();
    const res = await boardPatchReq({ boardId: await boardId(), swimlaneGroupBy: 'sprint' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_SWIMLANE_GROUP_BY');
  });

  it('PATCH /api/board → 400 when required fields are missing', async () => {
    await makeFixture();
    const res = await boardPatchReq({ boardId: await boardId() }); // no swimlaneGroupBy
    expect(res.status).toBe(400);
  });

  it('PATCH /api/board → 403 for a non-owner member', async () => {
    const fx = await makeFixture();
    const bId = await boardId();
    // A plain member in the same workspace, switched into the request context.
    const member = await usersService.createUser({
      email: 'board-routes-member@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    session.current = {
      user: { id: member.id, email: 'board-routes-member@example.com', name: 'Member' },
    };
    activeCtx.current = { ...activeCtx.current!, userId: member.id };

    const res = await boardPatchReq({ boardId: bId, swimlaneGroupBy: 'epic' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_BOARD_ADMIN');
  });

  it('PATCH column → 200 sets + 200 clears the WIP limit for the owner', async () => {
    await makeFixture();
    const columnId = await firstColumnId(await boardId());

    const set = await columnPatchReq(columnId, { wipLimit: 5 });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { wipLimit: number | null }).wipLimit).toBe(5);

    const clear = await columnPatchReq(columnId, { wipLimit: null });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { wipLimit: number | null }).wipLimit).toBeNull();
  });

  it('PATCH column → 400 for a negative limit', async () => {
    await makeFixture();
    const columnId = await firstColumnId(await boardId());
    const res = await columnPatchReq(columnId, { wipLimit: -1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_WIP_LIMIT');
  });

  it('PATCH column → 400 for a non-numeric body', async () => {
    await makeFixture();
    const columnId = await firstColumnId(await boardId());
    const res = await columnPatchReq(columnId, { wipLimit: 'three' });
    expect(res.status).toBe(400);
  });

  it('PATCH column → 404 for an unknown column', async () => {
    await makeFixture();
    const res = await columnPatchReq('col_does_not_exist', { wipLimit: 2 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('BOARD_COLUMN_NOT_FOUND');
  });
});
