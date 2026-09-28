import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET as planTreeGET } from '@/app/api/internal/ai/plan-tree/route';
import { GET as skeletonGET } from '@/app/api/internal/ai/skeleton/route';
import { POST as searchPOST } from '@/app/api/internal/ai/search-work-items/route';
import { GET as getItemGET } from '@/app/api/internal/ai/get-item/route';
import { GET as getSubtreeGET } from '@/app/api/internal/ai/get-subtree/route';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Story MOTIR-6574 · MOTIR-6582) — the OBSOLESCENCE mark on the
// internal AI boundary, through the REAL routes against real Postgres. Every row
// of `plan-tree`, `skeleton`, `search-work-items` and `get-subtree` carries the
// mark (the note stays off the breadth reads); `get-item` carries the mark, the
// note and the `supersedes` / `supersededBy` groups. The subtree read is a raw
// recursive CTE — the select a DTO-level change misses — so it is asserted by
// value, not by type. And no read drops or re-sorts a marked row.

const SERVICE_SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;
type Row = { key: string; obsolescence: string | null };

function headers(fx: Fx): Record<string, string> {
  return {
    authorization: `Bearer ${SERVICE_SECRET}`,
    'x-motir-job-token': mintJobToken({
      userId: fx.ctx.userId,
      workspaceId: fx.ctx.workspaceId,
      projectId: fx.projectId,
    }),
  };
}

function get(fx: Fx, path: string, query: Record<string, string> = {}): Request {
  const url = new URL(`http://core/api/internal/ai/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers: headers(fx) });
}

/** An epic → story (marked `outdated`, with a note) + a current task under it,
 *  and a newer task that `supersedes` the story. */
async function seed(fx: Fx): Promise<{
  epic: WorkItemDto;
  story: WorkItemDto;
  child: WorkItemDto;
  replacement: WorkItemDto;
}> {
  const create = (kind: 'epic' | 'story' | 'task', title: string, parentId?: string) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
      fx.ctx,
    );
  const epic = await create('epic', 'Epic');
  const story = await create('story', 'Old story', epic.id);
  const child = await create('task', 'Child', story.id);
  const replacement = await create('task', 'New way', epic.id);
  // A mark is a FINISHED card's state (MOTIR-6672).
  await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });
  await workItemsService.updateWorkItem(
    story.id,
    { obsolescence: 'outdated', obsolescenceNoteMd: 'The flow moved.' },
    fx.ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: replacement.id, toId: story.id, kind: 'supersedes' },
    fx.ctx,
  );
  return { epic, story, child, replacement };
}

function expectMarkOnEveryRow(rows: Row[], markedKey: string): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toHaveProperty('obsolescence');
    expect(row.obsolescence).toBe(row.key === markedKey ? 'outdated' : null);
    // The note is a body: it stays off the breadth rows.
    expect(row).not.toHaveProperty('obsolescenceNoteMd');
  }
}

describe('the obsolescence mark on the internal AI reads', () => {
  it('plan-tree and skeleton carry the mark on every row, and keep every row', async () => {
    const fx = await makeFixture();
    const { story } = await seed(fx);

    for (const [route, path] of [
      [planTreeGET, 'plan-tree'],
      [skeletonGET, 'skeleton'],
    ] as const) {
      const res = await route(get(fx, path));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Row[] };
      expect(body.items).toHaveLength(4);
      expectMarkOnEveryRow(body.items, story.identifier);
    }
  });

  it('search-work-items carries the mark on every hit — the marked card is not filtered out', async () => {
    const fx = await makeFixture();
    const { story } = await seed(fx);

    const res = await searchPOST(
      new Request('http://core/api/internal/ai/search-work-items', {
        method: 'POST',
        headers: { ...headers(fx), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Row[]; total: number };
    expect(body.total).toBe(4);
    expectMarkOnEveryRow(body.items, story.identifier);
  });

  it('get-subtree carries the mark on every node — read through the raw CTE', async () => {
    const fx = await makeFixture();
    const { epic, story, child } = await seed(fx);

    const res = await getSubtreeGET(
      get(fx, 'get-subtree', { rootKey: epic.identifier, depth: '2' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: Row[] };
    expect(body.nodes.map((n) => n.key)).toEqual(
      expect.arrayContaining([epic.identifier, story.identifier, child.identifier]),
    );
    expect(body.nodes).toHaveLength(4);
    expectMarkOnEveryRow(body.nodes, story.identifier);
  });

  it('get-item carries the mark, the note and both supersedes groups', async () => {
    const fx = await makeFixture();
    const { story, replacement } = await seed(fx);

    const marked = await getItemGET(get(fx, 'get-item', { key: story.identifier }));
    expect(marked.status).toBe(200);
    const item = (
      (await marked.json()) as {
        item: {
          obsolescence: string | null;
          obsolescenceNoteMd: string | null;
          supersedes: { item: { identifier: string } }[];
          supersededBy: { item: { identifier: string } }[];
        };
      }
    ).item;
    expect([item.obsolescence, item.obsolescenceNoteMd]).toEqual(['outdated', 'The flow moved.']);
    expect(item.supersededBy.map((l) => l.item.identifier)).toEqual([replacement.identifier]);
    expect(item.supersedes).toEqual([]);

    const newer = await getItemGET(get(fx, 'get-item', { key: replacement.identifier }));
    const newerItem = (
      (await newer.json()) as {
        item: {
          obsolescence: string | null;
          obsolescenceNoteMd: string | null;
          supersedes: { item: { identifier: string } }[];
          supersededBy: unknown[];
        };
      }
    ).item;
    expect([newerItem.obsolescence, newerItem.obsolescenceNoteMd]).toEqual([null, null]);
    expect(newerItem.supersedes.map((l) => l.item.identifier)).toEqual([story.identifier]);
    expect(newerItem.supersededBy).toEqual([]);
  });
});
