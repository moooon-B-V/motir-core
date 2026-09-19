import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The roadmap ROUTE's folder address (Bug MOTIR-5710 · MOTIR-5740). `folders=1` is
// the opt-in `/roadmap` sends; `folderId` addresses one folder's level; together
// with `parentId` it is a 400. Without `folders=1` the body is byte-for-byte the
// shipped read, which every other canvas calling this route relies on.
//
// The session is the one thing stubbed — a route test has no cookie jar, so the
// compliance gate hands back the actor. Everything after it is the shipped path.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

let fx: WorkItemFixture;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function get(query: string): Promise<Response> {
  const { GET } = await import('@/app/api/projects/[key]/roadmap/route');
  return GET(new Request(`http://localhost/api/projects/${fx.projectIdentifier}/roadmap${query}`), {
    params: Promise.resolve({ key: fx.projectIdentifier }),
  });
}

async function filedEpicTree() {
  const make = (kind: 'epic' | 'story', title: string, parentId: string | null = null) =>
    workItemsService.createWorkItem({ projectId: fx.projectId, kind, title, parentId }, fx.ctx);
  const road = await make('epic', 'On the road');
  const filed = await make('epic', 'Filed epic');
  await make('story', 'Under the filed epic', filed.id);
  const parked = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
    fx.ctx,
  );
  await foldersService.fileWorkItem(filed.id, { folderId: parked.id }, fx.ctx);
  return { road, filed, parked };
}

describe('GET /api/projects/[key]/roadmap — the folder address', () => {
  it('without folders=1, every level is byte-for-byte the shipped read', async () => {
    const { filed } = await filedEpicTree();

    for (const [query, parentId] of [
      ['', null],
      [`?parentId=${filed.id}`, filed.id],
    ] as const) {
      const res = await get(query);
      expect(res.status).toBe(200);
      const direct = await workItemsService.getProjectRoadmap(fx.projectId, parentId, fx.ctx, {
        scope: 'project',
        all: false,
      });
      expect(await res.text()).toBe(JSON.stringify(direct));
    }
  });

  it('with folders=1, the root leaves the filed epic out and carries the folders with their counts', async () => {
    const { road, parked } = await filedEpicTree();

    const body = await (await get('?folders=1')).json();

    expect(body.nodes.map((n: { id: string }) => n.id)).toEqual([road.id]);
    expect(body.levelTotal).toBe(1);
    const mine = body.folders.find((f: { id: string }) => f.id === parked.id);
    expect(mine).toMatchObject({ name: 'Parked', childFolderCount: 0, itemCount: 1 });
  });

  it('folders=1&folderId=<id> returns that folder’s filed items and child folders', async () => {
    const { filed, parked } = await filedEpicTree();

    const body = await (await get(`?folders=1&folderId=${parked.id}`)).json();

    expect(body.nodes.map((n: { id: string }) => n.id)).toEqual([filed.id]);
    expect(body.folders).toEqual([]);
  });

  it('parentId together with folderId is a 400 naming the conflict', async () => {
    const { road, parked } = await filedEpicTree();

    const res = await get(`?folders=1&parentId=${road.id}&folderId=${parked.id}`);

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('LEVEL_ADDRESS_CONFLICT');
  });

  it('an unknown folderId is an empty level, never a 500', async () => {
    await filedEpicTree();

    const res = await get('?folders=1&folderId=does-not-exist');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes).toEqual([]);
    expect(body.folders).toEqual([]);
  });
});
