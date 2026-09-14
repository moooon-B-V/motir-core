import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET, PATCH } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema, type WorkItemDetail } from '@/lib/api/v1/workItems/schema';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A work item's FOLDER placement over `/api/v1` (Story MOTIR-5310 · MOTIR-5412),
// end to end through `withV1Route` against real Postgres.
//
// What the card asks this file to prove, and where:
//   1  POST with `folderId` files the item; GET reads `folderId` + a root-first
//      `folderPath`, and both `null` for an unfiled item and for a story under a
//      filed epic                                     → 'reading placement'
//   2  PATCH files, unfiles, and changes a field + the folder in one revision
//                                                     → 'writing placement'
//   3  PATCH `parentKey` on a filed story is 200 and unfiles it — a 500 (the
//      `work_item_parent_xor_folder` CHECK) on `origin/main`
//                                                     → 'the re-parent fix'
//   4  every refusal: PLACEMENT_CONFLICT on both doors, CROSS_PROJECT_FOLDER,
//      FOLDER_NOT_FOUND, and a stale If-Match that changes nothing
//                                                     → 'placement refusals'

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function create(caller: V1ProjectCaller, body: unknown): Promise<Response> {
  return POST(
    new Request(`${BASE}/projects/${caller.projectKey}/work-items`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey: caller.projectKey }) },
  );
}

function update(
  caller: V1ProjectCaller,
  key: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return PATCH(
    new Request(`${BASE}/work-items/${key}`, {
      method: 'PATCH',
      headers: { ...caller.headers, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

function read(caller: V1ProjectCaller, key: string): Promise<Response> {
  return GET(new Request(`${BASE}/work-items/${key}`, { headers: caller.headers }), {
    params: Promise.resolve({ key }),
  });
}

async function detail(res: Response, status = 200): Promise<WorkItemDetail> {
  const body: unknown = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(status);
  return workItemDetailSchema.parse(body);
}

async function expectRefusal(res: Response, status: number, code: string): Promise<void> {
  const body = (await res.json()) as { code: string; error: string };
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(body.code).toBe(code);
}

/** `Parked ▸ 2025`, the nested folder every placement test files into. */
async function parked2025(caller: V1ProjectCaller) {
  const parked = await foldersService.createFolder(
    { projectId: caller.fixture.projectId, parentFolderId: null, name: 'Parked' },
    caller.ctx,
  );
  const year = await foldersService.createFolder(
    { projectId: caller.fixture.projectId, parentFolderId: parked.id, name: '2025' },
    caller.ctx,
  );
  return { parked, year };
}

async function revisionCount(key: string): Promise<number> {
  const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
  return adminDb.workItemRevision.count({ where: { workItemId: row.id } });
}

describe('reading placement', () => {
  it('POST with folderId creates the item filed, and GET reads the folder id and its path', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { year } = await parked2025(caller);

    const created = await detail(
      await create(caller, { kind: 'epic', title: 'Ideas', folderId: year.id }),
      201,
    );
    expect(created).toMatchObject({
      parentKey: null,
      folderId: year.id,
      folderPath: ['Parked', '2025'],
    });

    const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: created.key } });
    expect(row).toMatchObject({ folderId: year.id, parentId: null });

    const got = await detail(await read(caller, created.key));
    expect(got.folderId).toBe(year.id);
    expect(got.folderPath).toEqual(['Parked', '2025']);
  });

  it('reads both null for an unfiled item AND for a story under a filed epic', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { year } = await parked2025(caller);

    const loose = await detail(await create(caller, { kind: 'task', title: 'Loose' }), 201);
    expect(await detail(await read(caller, loose.key))).toMatchObject({
      folderId: null,
      folderPath: null,
    });

    const epic = await detail(
      await create(caller, { kind: 'epic', title: 'Filed', folderId: year.id }),
      201,
    );
    const story = await detail(
      await create(caller, { kind: 'story', title: 'Under it', parentKey: epic.key }),
      201,
    );
    // The item's OWN placement: the story is not filed, its ancestry travels as keys.
    expect(await detail(await read(caller, story.key))).toMatchObject({
      parentKey: epic.key,
      ancestorKeys: [epic.key],
      folderId: null,
      folderPath: null,
    });
  });
});

describe('writing placement', () => {
  it('PATCH { folderId } files, PATCH { folderId: null } unfiles, and each response reads it back', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { parked } = await parked2025(caller);
    const story = await detail(await create(caller, { kind: 'story', title: 'Wander' }), 201);

    const filed = await detail(await update(caller, story.key, { folderId: parked.id }));
    expect(filed).toMatchObject({ folderId: parked.id, folderPath: ['Parked'], parentKey: null });

    const unfiled = await detail(await update(caller, story.key, { folderId: null }));
    expect(unfiled).toMatchObject({ folderId: null, folderPath: null });
    const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: story.key } });
    expect(row.folderId).toBeNull();
  });

  it('PATCH { title, folderId } changes both in ONE revision', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { year } = await parked2025(caller);
    const story = await detail(await create(caller, { kind: 'story', title: 'Before' }), 201);
    const before = await revisionCount(story.key);

    const after = await detail(
      await update(caller, story.key, { title: 'After', folderId: year.id }),
    );

    expect(after).toMatchObject({
      title: 'After',
      folderId: year.id,
      folderPath: ['Parked', '2025'],
    });
    expect(await revisionCount(story.key)).toBe(before + 1);
  });
});

describe('the re-parent fix', () => {
  // ⚠️ On `origin/main` this PATCH wrote `parent_id` beside a set `folder_id` and
  // the `work_item_parent_xor_folder` CHECK refused it as a bare 500.
  it('PATCH { parentKey } on a filed story is 200 and leaves it under the parent, unfiled', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { parked } = await parked2025(caller);
    const epic = await detail(await create(caller, { kind: 'epic', title: 'Home' }), 201);
    const story = await detail(
      await create(caller, { kind: 'story', title: 'Filed', folderId: parked.id }),
      201,
    );

    const moved = await detail(await update(caller, story.key, { parentKey: epic.key }));

    expect(moved).toMatchObject({ parentKey: epic.key, folderId: null, folderPath: null });
    const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: story.key } });
    expect(row.folderId).toBeNull();
  });
});

describe('placement refusals', () => {
  it('parentKey + folderId together is 422 PLACEMENT_CONFLICT on POST and on PATCH, writing nothing', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { parked } = await parked2025(caller);
    const epic = await detail(await create(caller, { kind: 'epic', title: 'Home' }), 201);

    await expectRefusal(
      await create(caller, {
        kind: 'story',
        title: 'Both',
        parentKey: epic.key,
        folderId: parked.id,
      }),
      422,
      'PLACEMENT_CONFLICT',
    );
    expect(await adminDb.workItem.count({ where: { title: 'Both' } })).toBe(0);

    const story = await detail(await create(caller, { kind: 'story', title: 'Target' }), 201);
    await expectRefusal(
      await update(caller, story.key, {
        title: 'Renamed',
        parentKey: epic.key,
        folderId: parked.id,
      }),
      422,
      'PLACEMENT_CONFLICT',
    );
    expect(await detail(await read(caller, story.key))).toMatchObject({
      title: 'Target',
      parentKey: null,
      folderId: null,
    });
  });

  it("another project's folder is 422 CROSS_PROJECT_FOLDER; an unknown folder is 404 FOLDER_NOT_FOUND", async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const other = await projectsService.createProject({
      workspaceId: caller.workspace.id,
      actorUserId: caller.user.id,
      name: 'Second project',
      identifier: 'SECND',
    });
    const elsewhere = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      caller.ctx,
    );
    const story = await detail(await create(caller, { kind: 'story', title: 'Stays' }), 201);

    await expectRefusal(
      await create(caller, { kind: 'story', title: 'Cross', folderId: elsewhere.id }),
      422,
      'CROSS_PROJECT_FOLDER',
    );
    await expectRefusal(
      await update(caller, story.key, { folderId: elsewhere.id }),
      422,
      'CROSS_PROJECT_FOLDER',
    );
    await expectRefusal(
      await create(caller, {
        kind: 'story',
        title: 'Ghost',
        folderId: 'cfolderdoesnotexist000000',
      }),
      404,
      'FOLDER_NOT_FOUND',
    );
    await expectRefusal(
      await update(caller, story.key, { folderId: 'cfolderdoesnotexist000000' }),
      404,
      'FOLDER_NOT_FOUND',
    );
    expect(await adminDb.workItem.count({ where: { title: { in: ['Cross', 'Ghost'] } } })).toBe(0);
    expect((await detail(await read(caller, story.key))).folderId).toBeNull();
  });

  it('a stale If-Match with folderId is 412 and changes nothing', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { parked } = await parked2025(caller);
    const story = await detail(await create(caller, { kind: 'story', title: 'Raced' }), 201);
    const etag = (await read(caller, story.key)).headers.get('etag')!;
    // Another writer moves the row underneath the caller.
    await detail(await update(caller, story.key, { title: 'Moved underneath' }));

    await expectRefusal(
      await update(caller, story.key, { folderId: parked.id }, { 'if-match': etag }),
      412,
      'STALE_WORK_ITEM',
    );
    expect(await detail(await read(caller, story.key))).toMatchObject({
      title: 'Moved underneath',
      folderId: null,
    });
  });
});
