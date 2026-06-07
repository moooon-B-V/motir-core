import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardRepository } from '@/lib/repositories/boardRepository';
import { truncateAuthTables } from '../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// Board COLUMN-CONFIG API routes (Story 3.6 · Subtask 3.6.2). Real Postgres; we
// stub only the two session/context resolvers the test env can't supply via
// cookies (getSession, getActiveProject) — every DB read/write goes through the
// real service → repo → Prisma chain. This asserts the TRANSPORT contract
// (status codes + the typed-error → HTTP mapping); the config behaviour itself
// is covered by column-config-service.test.ts.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

// Import AFTER the mocks are registered.
const { POST: columnsPOST } = await import('@/app/api/board/columns/route');
const { PATCH: columnPATCH, DELETE: columnDELETE } =
  await import('@/app/api/board/columns/[columnId]/route');
const { PUT: statusesPUT } = await import('@/app/api/board/columns/[columnId]/statuses/route');
const { DELETE: statusDELETE } =
  await import('@/app/api/board/columns/[columnId]/statuses/[statusId]/route');
const { PATCH: boardPATCH } = await import('@/app/api/board/route');

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
  ownerId: string;
  memberId: string;
  workspaceId: string;
  projectId: string;
  project: ProjectContext['project'];
  boardId: string;
  columnByStatusKey: Map<string, string>;
  statusIdByKey: Map<string, string>;
}

async function makeFixture(label: string): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `col-routes-owner-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Routes Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Routes WS ${label}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: `Routes Demo ${label}`,
    identifier: 'RTE',
  });
  const member = await usersService.createUser({
    email: `col-routes-member-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Routes Member',
  });
  await db.workspaceMembership.create({ data: { userId: member.id, workspaceId, role: 'member' } });

  const board = await boardRepository.findDefaultForProject(project.id, workspaceId);
  if (!board) throw new Error('expected a seeded default board');
  const statuses = await db.workflowStatus.findMany({ where: { projectId: project.id } });
  const statusIdByKey = new Map(statuses.map((s) => [s.key, s.id]));
  const keyByStatusId = new Map(statuses.map((s) => [s.id, s.key]));
  const mappings = await db.boardColumnStatus.findMany({ where: { boardId: board.id } });
  const columnByStatusKey = new Map<string, string>();
  for (const m of mappings) {
    const key = keyByStatusId.get(m.statusId);
    if (key) columnByStatusKey.set(key, m.columnId);
  }
  return {
    ownerId: owner.id,
    memberId: member.id,
    workspaceId,
    projectId: project.id,
    project,
    boardId: board.id,
    columnByStatusKey,
    statusIdByKey,
  };
}

/** Sign in as the owner of `fx` with `fx`'s project active. */
function asOwner(fx: Fixture): void {
  session.current = { user: { id: fx.ownerId, email: 'o', name: 'o' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** Sign in as the plain member of `fx`. */
function asMember(fx: Fixture): void {
  session.current = { user: { id: fx.memberId, email: 'm', name: 'm' } };
  activeCtx.current = {
    userId: fx.memberId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

function jsonReq(method: string, url: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/board/columns', () => {
  it('201s and returns the new column for the owner', async () => {
    const fx = await makeFixture('post-ok');
    asOwner(fx);
    const res = await columnsPOST(
      jsonReq('POST', `${BASE}/api/board/columns`, { boardId: fx.boardId, name: 'Triage' }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'Triage' });
  });

  it('400s a missing name', async () => {
    const fx = await makeFixture('post-bad');
    asOwner(fx);
    const res = await columnsPOST(
      jsonReq('POST', `${BASE}/api/board/columns`, { boardId: fx.boardId }),
    );
    expect(res.status).toBe(400);
  });

  it('400s an empty name (InvalidColumnNameError)', async () => {
    const fx = await makeFixture('post-empty');
    asOwner(fx);
    const res = await columnsPOST(
      jsonReq('POST', `${BASE}/api/board/columns`, { boardId: fx.boardId, name: '  ' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_COLUMN_NAME');
  });

  it('403s a non-owner member', async () => {
    const fx = await makeFixture('post-403');
    asMember(fx);
    const res = await columnsPOST(
      jsonReq('POST', `${BASE}/api/board/columns`, { boardId: fx.boardId, name: 'X' }),
    );
    expect(res.status).toBe(403);
  });

  it('401s without a session', async () => {
    const fx = await makeFixture('post-401');
    const res = await columnsPOST(
      jsonReq('POST', `${BASE}/api/board/columns`, { boardId: fx.boardId, name: 'X' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/board/columns/[columnId]', () => {
  function patch(columnId: string, body: unknown) {
    return columnPATCH(jsonReq('PATCH', `${BASE}/api/board/columns/${columnId}`, body), {
      params: Promise.resolve({ columnId }),
    });
  }

  it('renames via { name }', async () => {
    const fx = await makeFixture('patch-name');
    asOwner(fx);
    const columnId = fx.columnByStatusKey.get('todo')!;
    const res = await patch(columnId, { name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: columnId, name: 'Renamed' });
  });

  it('reorders via { position }', async () => {
    const fx = await makeFixture('patch-pos');
    asOwner(fx);
    const cols = await db.boardColumn.findMany({
      where: { boardId: fx.boardId },
      orderBy: { position: 'asc' },
    });
    const res = await patch(cols[cols.length - 1]!.id, { position: 'a0' });
    expect(res.status).toBe(200);
  });

  it('still sets the WIP limit via { wipLimit } (3.3.3 unchanged)', async () => {
    const fx = await makeFixture('patch-wip');
    asOwner(fx);
    const columnId = fx.columnByStatusKey.get('todo')!;
    const res = await patch(columnId, { wipLimit: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ wipLimit: 5 });
  });

  it('400s an unrecognized body', async () => {
    const fx = await makeFixture('patch-bad');
    asOwner(fx);
    const res = await patch(fx.columnByStatusKey.get('todo')!, { nope: 1 });
    expect(res.status).toBe(400);
  });

  it('403s a non-owner member', async () => {
    const fx = await makeFixture('patch-403');
    asMember(fx);
    const res = await patch(fx.columnByStatusKey.get('todo')!, { name: 'X' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/board/columns/[columnId]', () => {
  function del(columnId: string) {
    return columnDELETE(
      new Request(`${BASE}/api/board/columns/${columnId}`, { method: 'DELETE' }),
      {
        params: Promise.resolve({ columnId }),
      },
    );
  }

  it('204s deleting an empty column', async () => {
    const fx = await makeFixture('del-204');
    asOwner(fx);
    const res = await del(fx.columnByStatusKey.get('blocked')!);
    expect(res.status).toBe(204);
  });

  it('409s a column that still holds cards (ColumnNotEmptyError)', async () => {
    const fx = await makeFixture('del-409');
    asOwner(fx);
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Live' },
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
    );
    const res = await del(fx.columnByStatusKey.get('todo')!);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('COLUMN_NOT_EMPTY');
  });

  it('403s a non-owner member', async () => {
    const fx = await makeFixture('del-403');
    asMember(fx);
    const res = await del(fx.columnByStatusKey.get('blocked')!);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/board/columns/[columnId]/statuses', () => {
  function put(columnId: string, body: unknown) {
    return statusesPUT(jsonReq('PUT', `${BASE}/api/board/columns/${columnId}/statuses`, body), {
      params: Promise.resolve({ columnId }),
    });
  }

  it('200s mapping a status into a column', async () => {
    const fx = await makeFixture('put-ok');
    asOwner(fx);
    const columnId = fx.columnByStatusKey.get('todo')!;
    const statusId = fx.statusIdByKey.get('blocked')!;
    const res = await put(columnId, { boardId: fx.boardId, statusId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ boardId: fx.boardId, columnId, statusId });
  });

  it('404s a status not in the project', async () => {
    const fx = await makeFixture('put-foreign');
    const other = await makeFixture('put-foreign-b');
    asOwner(fx);
    const res = await put(fx.columnByStatusKey.get('todo')!, {
      boardId: fx.boardId,
      statusId: other.statusIdByKey.get('todo')!,
    });
    expect(res.status).toBe(404);
  });

  it('400s a missing statusId', async () => {
    const fx = await makeFixture('put-bad');
    asOwner(fx);
    const res = await put(fx.columnByStatusKey.get('todo')!, { boardId: fx.boardId });
    expect(res.status).toBe(400);
  });

  it('403s a non-owner member', async () => {
    const fx = await makeFixture('put-403');
    asMember(fx);
    const res = await put(fx.columnByStatusKey.get('todo')!, {
      boardId: fx.boardId,
      statusId: fx.statusIdByKey.get('blocked')!,
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/board/columns/[columnId]/statuses/[statusId]', () => {
  function del(columnId: string, statusId: string, boardId?: string) {
    const q = boardId ? `?boardId=${boardId}` : '';
    return statusDELETE(
      new Request(`${BASE}/api/board/columns/${columnId}/statuses/${statusId}${q}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ columnId, statusId }) },
    );
  }

  it('204s unmapping a status', async () => {
    const fx = await makeFixture('unmap-204');
    asOwner(fx);
    const res = await del(
      fx.columnByStatusKey.get('todo')!,
      fx.statusIdByKey.get('todo')!,
      fx.boardId,
    );
    expect(res.status).toBe(204);
  });

  it('400s when boardId is absent', async () => {
    const fx = await makeFixture('unmap-noboard');
    asOwner(fx);
    const res = await del(fx.columnByStatusKey.get('todo')!, fx.statusIdByKey.get('todo')!);
    expect(res.status).toBe(400);
  });

  it('403s a non-owner member', async () => {
    const fx = await makeFixture('unmap-403');
    asMember(fx);
    const res = await del(
      fx.columnByStatusKey.get('todo')!,
      fx.statusIdByKey.get('todo')!,
      fx.boardId,
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/board (rename)', () => {
  it('200s renaming the board via { name }', async () => {
    const fx = await makeFixture('board-name');
    asOwner(fx);
    const res = await boardPATCH(
      jsonReq('PATCH', `${BASE}/api/board`, { boardId: fx.boardId, name: 'Delivery' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: fx.boardId, name: 'Delivery' });
  });

  it('400s an empty board name', async () => {
    const fx = await makeFixture('board-name-empty');
    asOwner(fx);
    const res = await boardPATCH(
      jsonReq('PATCH', `${BASE}/api/board`, { boardId: fx.boardId, name: '  ' }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_BOARD_NAME');
  });

  it('403s a non-owner member renaming the board', async () => {
    const fx = await makeFixture('board-name-403');
    asMember(fx);
    const res = await boardPATCH(
      jsonReq('PATCH', `${BASE}/api/board`, { boardId: fx.boardId, name: 'X' }),
    );
    expect(res.status).toBe(403);
  });
});
