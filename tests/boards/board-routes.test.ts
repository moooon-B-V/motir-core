import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
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
const { GET: boardGET } = await import('@/app/api/board/route');
const { GET: cardsGET } = await import('@/app/api/board/columns/[columnId]/cards/route');
const { POST: movePOST } = await import('@/app/api/board/move/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
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

function cardsReq(columnId: string, query: string) {
  return cardsGET(new Request(`${BASE}/api/board/columns/${columnId}/cards${query}`), {
    params: Promise.resolve({ columnId }),
  });
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

describe('board API routes', () => {
  it('GET /api/board → 401 without a session', async () => {
    session.current = null;
    const res = await boardGET();
    expect(res.status).toBe(401);
  });

  it('GET /api/board → the projection for the active project', async () => {
    await makeFixture();
    const res = await boardGET();
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

  it('GET column cards → the lazy page; missing boardId → 400', async () => {
    const fx = await makeFixture();
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A' },
      {
        userId: fx.userId,
        workspaceId: fx.workspaceId,
      },
    );
    const board = (await (await boardGET()).json()) as BoardProjectionDto;
    const todo = board.columns.find((c) => c.statusKeys[0] === 'todo')!;

    const ok = await cardsReq(todo.id, `?boardId=${board.boardId}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { cards: unknown[] }).cards).toHaveLength(1);

    const bad = await cardsReq(todo.id, '');
    expect(bad.status).toBe(400);
  });

  it('POST /api/board/move → 200 for a legal cross-column move (status persists)', async () => {
    const fx = await makeFixture();
    const card = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'movable' },
      { userId: fx.userId, workspaceId: fx.workspaceId },
    );
    const board = (await (await boardGET()).json()) as BoardProjectionDto;
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
    const board = (await (await boardGET()).json()) as BoardProjectionDto;
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
