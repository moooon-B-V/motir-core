import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as LIST, POST as CREATE } from '@/app/api/v1/projects/[projectKey]/folders/route';
import { DELETE, GET as GET_ONE, PATCH } from '@/app/api/v1/folders/[folderId]/route';
import {
  folderDeletionSchema,
  folderSchema,
  readFolderLevelPosition,
  toUpdateFolderInput,
  type V1Folder,
} from '@/lib/api/v1/folders/schema';
import { encodeCollectionCursor } from '@/lib/api/v1/pagination';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import {
  createV1ProjectCaller,
  withTokenFor,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The `/api/v1` FOLDER resource (Story MOTIR-5310 · MOTIR-5408), end to end
// through `withV1Route` against real Postgres.
//
// What the card asks this file to prove, and where:
//   1  all five operations — create, nest, list both levels with `path`, page a
//      level of 3 at limit=2, rename, move, reorder, delete moving contents up
//                                                    → 'the folder lifecycle'
//   2  each of the six folder codes through a route, none a 500
//                                                    → 'every folder refusal'
//   3  a PATCH carrying a rename AND a placement is 422 and changes nothing
//                                                    → 'rename OR placement'
//   4  a token bound to project A gets 404 for project B's folder; a
//      browse-only token gets 403 on every write     → 'who reaches a folder'

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function json(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'content-type': 'application/json' };
}

function create(
  caller: { headers: Record<string, string> },
  projectKey: string,
  body: unknown,
): Promise<Response> {
  return CREATE(
    new Request(`${BASE}/projects/${projectKey}/folders`, {
      method: 'POST',
      headers: json(caller.headers),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey }) },
  );
}

function list(
  caller: { headers: Record<string, string> },
  projectKey: string,
  query = '',
): Promise<Response> {
  return LIST(
    new Request(`${BASE}/projects/${projectKey}/folders${query}`, { headers: caller.headers }),
    { params: Promise.resolve({ projectKey }) },
  );
}

function getOne(caller: { headers: Record<string, string> }, folderId: string) {
  return GET_ONE(new Request(`${BASE}/folders/${folderId}`, { headers: caller.headers }), {
    params: Promise.resolve({ folderId }),
  });
}

function patch(caller: { headers: Record<string, string> }, folderId: string, body: unknown) {
  return PATCH(
    new Request(`${BASE}/folders/${folderId}`, {
      method: 'PATCH',
      headers: json(caller.headers),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ folderId }) },
  );
}

function del(caller: { headers: Record<string, string> }, folderId: string) {
  return DELETE(
    new Request(`${BASE}/folders/${folderId}`, { method: 'DELETE', headers: caller.headers }),
    { params: Promise.resolve({ folderId }) },
  );
}

async function created(res: Response): Promise<V1Folder> {
  expect(res.status).toBe(201);
  return folderSchema.parse(await res.json());
}

async function page(res: Response): Promise<{ items: V1Folder[]; nextCursor: string | null }> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
  return { items: body.items.map((i) => folderSchema.parse(i)), nextCursor: body.nextCursor };
}

async function expectRefusal(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { code: string; error: string };
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe('string');
}

async function editor(): Promise<V1ProjectCaller> {
  return createV1ProjectCaller({ permissions: [...EDITOR] });
}

/** A second project in the caller's workspace, with one folder in it. */
async function foreignFolder(caller: V1ProjectCaller) {
  const other = await projectsService.createProject({
    workspaceId: caller.workspace.id,
    actorUserId: caller.user.id,
    name: 'Second project',
    identifier: 'SECND',
  });
  const folder = await foldersService.createFolder(
    { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
    caller.ctx,
  );
  return { project: other, folder };
}

describe('the folder lifecycle', () => {
  it('creates, nests, lists both levels with their paths, and reads one back', async () => {
    const caller = await editor();
    const createdRes = await create(caller, caller.projectKey, { name: '  Parked ' });
    expect(createdRes.headers.get('Location')).toMatch(/^\/api\/v1\/folders\//);
    const parked = await created(createdRes);
    expect(parked).toMatchObject({
      projectKey: caller.projectKey,
      parentFolderId: null,
      name: 'Parked',
      path: ['Parked'],
    });

    const year = await created(
      await create(caller, caller.projectKey, { name: '2025', parentFolderId: parked.id }),
    );
    expect(year).toMatchObject({ parentFolderId: parked.id, path: ['Parked', '2025'] });

    const root = await page(await list(caller, caller.projectKey));
    expect(root.items.map((f) => f.id)).toEqual([parked.id]);
    expect(root.nextCursor).toBeNull();

    const child = await page(await list(caller, caller.projectKey, `?parentFolderId=${parked.id}`));
    expect(child.items).toEqual([year]);

    const one = await getOne(caller, year.id);
    expect(one.status).toBe(200);
    expect(folderSchema.parse(await one.json())).toEqual(year);
  });

  it('pages a level of three at limit=2 by following nextCursor, with no skip or repeat', async () => {
    const caller = await editor();
    const ids: string[] = [];
    for (const name of ['A', 'B', 'C']) {
      ids.push((await created(await create(caller, caller.projectKey, { name }))).id);
    }

    const first = await page(await list(caller, caller.projectKey, '?limit=2'));
    expect(first.items.map((f) => f.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();

    const second = await page(
      await list(
        caller,
        caller.projectKey,
        `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
    );
    expect(second.items.map((f) => f.id)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();
  });

  it('renames, moves into a sibling, and reorders between two siblings', async () => {
    const caller = await editor();
    const a = await created(await create(caller, caller.projectKey, { name: 'A' }));
    const b = await created(await create(caller, caller.projectKey, { name: 'B' }));
    const c = await created(await create(caller, caller.projectKey, { name: 'C' }));

    const renamed = await patch(caller, a.id, { name: 'Alpha' });
    expect(renamed.status).toBe(200);
    expect(folderSchema.parse(await renamed.json())).toMatchObject({
      id: a.id,
      name: 'Alpha',
      path: ['Alpha'],
    });

    const moved = await patch(caller, c.id, { parentFolderId: b.id });
    expect(moved.status).toBe(200);
    expect(folderSchema.parse(await moved.json())).toMatchObject({
      parentFolderId: b.id,
      path: ['B', 'C'],
    });

    // Back to the root, then between B and a new D: a placement with neighbours.
    const d = await created(await create(caller, caller.projectKey, { name: 'D' }));
    const back = await patch(caller, c.id, { parentFolderId: null, beforeId: b.id, afterId: d.id });
    expect(back.status).toBe(200);

    // A pure reorder — no parentFolderId — keeps the parent: Alpha after D.
    const reordered = await patch(caller, a.id, { beforeId: d.id });
    expect(reordered.status).toBe(200);
    expect(folderSchema.parse(await reordered.json()).parentFolderId).toBeNull();

    const root = await page(await list(caller, caller.projectKey));
    expect(root.items.map((f) => f.name)).toEqual(['B', 'C', 'D', 'Alpha']);
  });

  it('deletes a folder holding a folder and a filed work item, moving both up', async () => {
    const caller = await editor();
    const outer = await created(await create(caller, caller.projectKey, { name: 'Outer' }));
    const doomed = await created(
      await create(caller, caller.projectKey, { name: 'Doomed', parentFolderId: outer.id }),
    );
    const inner = await created(
      await create(caller, caller.projectKey, { name: 'Inner', parentFolderId: doomed.id }),
    );
    const story = await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'story', title: 'Filed', folderId: doomed.id },
      caller.ctx,
    );

    const res = await del(caller, doomed.id);
    expect(res.status).toBe(200);
    expect(folderDeletionSchema.parse(await res.json())).toEqual({
      deletedFolderId: doomed.id,
      destinationFolderId: outer.id,
      movedFolderIds: [inner.id],
      movedWorkItemIds: [story.id],
    });

    expect(folderSchema.parse(await (await getOne(caller, inner.id)).json())).toMatchObject({
      parentFolderId: outer.id,
      path: ['Outer', 'Inner'],
    });
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
    expect(row.folderId).toBe(outer.id);
    await expectRefusal(await getOne(caller, doomed.id), 404, 'FOLDER_NOT_FOUND');
  });
});

describe('every folder refusal', () => {
  it('maps each of the six folder codes to its status — never a 500', async () => {
    const caller = await editor();
    const parent = await created(await create(caller, caller.projectKey, { name: 'Parent' }));
    const child = await created(
      await create(caller, caller.projectKey, { name: 'Child', parentFolderId: parent.id }),
    );
    const { folder: elsewhere } = await foreignFolder(caller);

    await expectRefusal(await getOne(caller, 'no-such-folder'), 404, 'FOLDER_NOT_FOUND');
    await expectRefusal(
      await create(caller, caller.projectKey, { name: '   ' }),
      422,
      'INVALID_FOLDER_NAME',
    );
    await expectRefusal(
      await create(caller, caller.projectKey, { name: 'parent' }),
      409,
      'FOLDER_NAME_TAKEN',
    );
    await expectRefusal(
      await patch(caller, parent.id, { parentFolderId: child.id }),
      422,
      'FOLDER_CYCLE',
    );
    await expectRefusal(
      await create(caller, caller.projectKey, { name: 'Stray', parentFolderId: elsewhere.id }),
      422,
      'CROSS_PROJECT_FOLDER',
    );

    const root = await created(await create(caller, caller.projectKey, { name: 'Root' }));
    await workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'subtask', title: 'Filed', folderId: root.id },
      caller.ctx,
    );
    await expectRefusal(await del(caller, root.id), 409, 'SUBTASK_NEEDS_PLACEMENT');
  });

  it('refuses a list under a parent that is not a folder of this project, and a foreign cursor', async () => {
    const caller = await editor();
    await expectRefusal(
      await list(caller, caller.projectKey, '?parentFolderId=missing'),
      404,
      'FOLDER_NOT_FOUND',
    );
    const sprintCursor = encodeCollectionCursor('sprints', 'x');
    await expectRefusal(
      await list(caller, caller.projectKey, `?cursor=${encodeURIComponent(sprintCursor)}`),
      422,
      'INVALID_CURSOR',
    );
    const malformed = encodeCollectionCursor('folders', { position: 'a0' });
    await expectRefusal(
      await list(caller, caller.projectKey, `?cursor=${encodeURIComponent(malformed)}`),
      422,
      'INVALID_CURSOR',
    );
  });
});

describe('rename OR placement', () => {
  it('refuses a PATCH carrying name and parentFolderId together, changing nothing', async () => {
    const caller = await editor();
    const a = await created(await create(caller, caller.projectKey, { name: 'A' }));
    const b = await created(await create(caller, caller.projectKey, { name: 'B' }));

    await expectRefusal(
      await patch(caller, a.id, { name: 'Renamed', parentFolderId: b.id }),
      422,
      'INVALID_REQUEST',
    );
    await expectRefusal(await patch(caller, a.id, {}), 422, 'INVALID_REQUEST');

    expect(folderSchema.parse(await (await getOne(caller, a.id)).json())).toEqual(a);
  });

  it('splits a body into exactly one group', () => {
    expect(toUpdateFolderInput({ name: 'X' })).toEqual({ name: 'X' });
    expect(toUpdateFolderInput({ afterId: 'b', beforeId: null })).toEqual({
      afterId: 'b',
      beforeId: null,
    });
    expect(toUpdateFolderInput({ parentFolderId: null })).toEqual({ parentFolderId: null });
    expect(() => toUpdateFolderInput({ name: 'X', afterId: 'b' })).toThrow(/renames/);
  });

  it('reads a folder cursor position only when both halves are present', () => {
    expect(readFolderLevelPosition({ position: 'a0', id: 'x' })).toEqual({
      position: 'a0',
      id: 'x',
    });
    expect(readFolderLevelPosition(null)).toBeUndefined();
    expect(readFolderLevelPosition('a0')).toBeUndefined();
    expect(readFolderLevelPosition({ position: '', id: 'x' })).toBeUndefined();
    expect(readFolderLevelPosition({ position: 'a0', id: 7 })).toBeUndefined();
  });
});

describe('who reaches a folder', () => {
  it('answers 404 to a token bound to project A for project B’s folder, on GET, PATCH and DELETE', async () => {
    const caller = await editor();
    const { folder } = await foreignFolder(caller);

    await expectRefusal(await getOne(caller, folder.id), 404, 'FOLDER_NOT_FOUND');
    await expectRefusal(await patch(caller, folder.id, { name: 'Taken' }), 404, 'FOLDER_NOT_FOUND');
    await expectRefusal(await del(caller, folder.id), 404, 'FOLDER_NOT_FOUND');

    const row = await adminDb.folder.findUniqueOrThrow({ where: { id: folder.id } });
    expect(row.name).toBe('Elsewhere');
  });

  it('answers 404 for a folder in another workspace', async () => {
    const caller = await editor();
    const stranger = await createV1ProjectCaller({
      permissions: [...EDITOR],
      workspaceName: 'Other tenant',
      identifier: 'OTHR',
    });
    const theirs = await created(await create(stranger, stranger.projectKey, { name: 'Theirs' }));
    await expectRefusal(await getOne(caller, theirs.id), 404, 'FOLDER_NOT_FOUND');
  });

  it('refuses every write to a browse-only token with 403, and still lets it read', async () => {
    const caller = await editor();
    const a = await created(await create(caller, caller.projectKey, { name: 'A' }));
    const reader = await withTokenFor(caller.user, caller.workspace, {
      permissions: ['project:browse'],
      projectId: caller.fixture.projectId,
    });

    await expectRefusal(
      await create(reader, caller.projectKey, { name: 'No' }),
      403,
      'INSUFFICIENT_PERMISSION',
    );
    await expectRefusal(await patch(reader, a.id, { name: 'No' }), 403, 'INSUFFICIENT_PERMISSION');
    await expectRefusal(await del(reader, a.id), 403, 'INSUFFICIENT_PERMISSION');

    expect((await getOne(reader, a.id)).status).toBe(200);
    expect((await list(reader, caller.projectKey)).status).toBe(200);
  });
});
