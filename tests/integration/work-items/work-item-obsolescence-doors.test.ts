import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkItemObsolescence } from '@/generated/prisma/client';
import { GET as LIST, POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET, PATCH } from '@/app/api/v1/work-items/[key]/route';
import {
  DELETE as LINKS_DELETE,
  GET as LINKS_GET,
  POST as LINKS_POST,
} from '@/app/api/v1/work-items/[key]/links/route';
import { GET as getItemGET } from '@/app/api/internal/ai/get-item/route';
import { GET as getSubtreeGET } from '@/app/api/internal/ai/get-subtree/route';
import { GET as planTreeGET } from '@/app/api/internal/ai/plan-tree/route';
import { POST as searchPOST } from '@/app/api/internal/ai/search-work-items/route';
import { mintJobToken } from '@/lib/ai/jobToken';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import {
  obsolescenceSchema,
  workItemDetailSchema,
  workItemLinkGroupsSchema,
} from '@/lib/api/v1/workItems/schema';
import { MCP_TOOL_INPUT_SCHEMAS } from '@/lib/apiDocs/mcpToolSchemas';
import { db } from '@/lib/db';
import type { WorkItemDto, WorkItemKindDto } from '@/lib/dto/workItems';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { FILTER_FIELDS } from '@/lib/filters/registry';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runLinkWorkItems, runUnlinkWorkItems } from '@/lib/mcp/tools/linkWorkItems';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { runSkeleton } from '@/lib/mcp/tools/skeleton';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import { boardsService } from '@/lib/services/boardsService';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { InvalidObsolescenceError } from '@/lib/workItems/errors';
import { SelfLinkError } from '@/lib/workItems/linkErrors';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6574 · MOTIR-6584 — the story's INTEGRATION gate. The four code
// children each prove their own half of a seam; this file proves the ASSEMBLY,
// against real Postgres: ONE obsolescence mark and ONE `supersedes` edge,
// written through one door and read back unchanged through every other — the
// service, REST v1, the MCP tools and the internal AI routes — then cleared
// through a different door and read back empty everywhere. Around that: the mark
// on every kind and every status (a `done`, a `cancelled` and an archived card
// among them) with nothing else moving; the typed refusals on every write door;
// the filter's four operators and a saved-filter round trip; the five
// enumerations of the scale agreeing; and — the negative the story promises —
// no read dropping or re-sorting a marked card, asserted BESIDE unmarked rows,
// so a read that silently filtered could not pass by returning everything.

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;
const SERVICE_SECRET = 'core-callback-secret-test';
const NOTE = 'The flow moved to the v2 importer.\nSee the replacing story.';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "saved_filter", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Mark = { obsolescence: string | null; obsolescenceNoteMd?: string | null };
type KeyedRow = Mark & { key: string };

// ── the doors ──────────────────────────────────────────────────────────────

function restPatch(c: V1ProjectCaller, key: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`${BASE}/work-items/${key}`, {
      method: 'PATCH',
      headers: { ...c.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}
function restCreate(c: V1ProjectCaller, body: unknown): Promise<Response> {
  return POST(
    new Request(`${BASE}/projects/${c.projectKey}/work-items`, {
      method: 'POST',
      headers: { ...c.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey: c.projectKey }) },
  );
}
async function restDetail(c: V1ProjectCaller, key: string) {
  const res = await GET(new Request(`${BASE}/work-items/${key}`, { headers: c.headers }), {
    params: Promise.resolve({ key }),
  });
  expect(res.status).toBe(200);
  return workItemDetailSchema.parse(await res.json());
}
async function restCollection(c: V1ProjectCaller): Promise<KeyedRow[]> {
  const res = await LIST(
    new Request(`${BASE}/projects/${c.projectKey}/work-items?limit=100`, { headers: c.headers }),
    { params: Promise.resolve({ projectKey: c.projectKey }) },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: KeyedRow[] }).items;
}
async function restLinks(c: V1ProjectCaller, key: string) {
  const res = await LINKS_GET(
    new Request(`${BASE}/work-items/${key}/links`, { headers: c.headers }),
    { params: Promise.resolve({ key }) },
  );
  expect(res.status).toBe(200);
  return workItemLinkGroupsSchema.parse(await res.json());
}
function restLink(
  c: V1ProjectCaller,
  key: string,
  body: { toKey: string; relationship: string },
): Promise<Response> {
  return LINKS_POST(
    new Request(`${BASE}/work-items/${key}/links`, {
      method: 'POST',
      headers: { ...c.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}
function restUnlink(
  c: V1ProjectCaller,
  key: string,
  q: { toKey: string; relationship: string },
): Promise<Response> {
  const url = new URL(`${BASE}/work-items/${key}/links`);
  url.searchParams.set('toKey', q.toKey);
  url.searchParams.set('relationship', q.relationship);
  return LINKS_DELETE(new Request(url, { method: 'DELETE', headers: c.headers }), {
    params: Promise.resolve({ key }),
  });
}
async function refusal(res: Response): Promise<{ status: number; code: string }> {
  return { status: res.status, code: ((await res.json()) as { code: string }).code };
}

function aiHeaders(c: V1ProjectCaller): Record<string, string> {
  return {
    authorization: `Bearer ${SERVICE_SECRET}`,
    'x-motir-job-token': mintJobToken({
      userId: c.ctx.userId,
      workspaceId: c.fixture.workspaceId,
      projectId: c.fixture.projectId,
    }),
  };
}
function aiGet(c: V1ProjectCaller, path: string, query: Record<string, string> = {}): Request {
  const url = new URL(`http://core/api/internal/ai/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers: aiHeaders(c) });
}
async function aiGetItem(c: V1ProjectCaller, key: string) {
  const res = await getItemGET(aiGet(c, 'get-item', { key }));
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      item: Mark & {
        supersedes: { item: { identifier: string } }[];
        supersededBy: { item: { identifier: string } }[];
      };
    }
  ).item;
}
async function aiRows(c: V1ProjectCaller, rootKey: string): Promise<Record<string, KeyedRow[]>> {
  const planTree = await planTreeGET(aiGet(c, 'plan-tree'));
  const search = await searchPOST(
    new Request('http://core/api/internal/ai/search-work-items', {
      method: 'POST',
      headers: { ...aiHeaders(c), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );
  const subtree = await getSubtreeGET(aiGet(c, 'get-subtree', { rootKey, depth: '3' }));
  for (const res of [planTree, search, subtree]) expect(res.status).toBe(200);
  return {
    'plan-tree': ((await planTree.json()) as { items: KeyedRow[] }).items,
    'search-work-items': ((await search.json()) as { items: KeyedRow[] }).items,
    'get-subtree': ((await subtree.json()) as { nodes: KeyedRow[] }).nodes,
  };
}

function structured<T>(res: CallToolResult): T {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as T;
}
async function mcpSearch(c: V1ProjectCaller, ast?: FilterAst): Promise<KeyedRow[]> {
  const res = await runSearchWorkItems(
    { projectKey: c.projectKey, ...(ast ? { filter: { version: 'v1', ...ast } } : {}) } as never,
    c.ctx,
  );
  return structured<{ items: KeyedRow[] }>(res).items;
}
async function mcpSkeleton(c: V1ProjectCaller): Promise<KeyedRow[]> {
  return structured<{ items: KeyedRow[] }>(await runSkeleton({ projectKey: c.projectKey }, c.ctx))
    .items;
}
async function mcpReady(c: V1ProjectCaller): Promise<KeyedRow[]> {
  return structured<{ items: KeyedRow[] }>(await runListReady({ projectKey: c.projectKey }, c.ctx))
    .items;
}

const pick = (rows: KeyedRow[], key: string): KeyedRow => {
  const row = rows.find((r) => r.key === key);
  expect(row, `row ${key}`).toBeDefined();
  return row!;
};
const markOf = (m: Mark) => [m.obsolescence, m.obsolescenceNoteMd ?? null];

async function create(
  c: V1ProjectCaller,
  kind: WorkItemKindDto,
  title: string,
  parentId?: string,
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: c.fixture.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    c.ctx,
  );
}

// ── one value, every door ──────────────────────────────────────────────────

/**
 * Every read the story names, for the DONE story (`storyKey`) under `epicKey`
 * and the READY leaf (`leafKey`) — a `done` card is by definition absent from
 * the ready set, so the `list_ready` door is read on a leaf that received the
 * same MCP write. Returns `[mark, note]` per door; a breadth read that carries
 * the mark only (the skeleton and the internal row reads) reports `note: null`.
 */
async function readEveryDoor(
  c: V1ProjectCaller,
  keys: { epicKey: string; storyKey: string; leafKey: string },
): Promise<Record<string, Array<string | null>>> {
  const { epicKey, storyKey, leafKey } = keys;
  const mcpGet = structured<{ item: Mark }>(await runGetWorkItem({ key: storyKey }, c.ctx));
  const mcpParent = structured<{ children: Array<Mark & { identifier: string }> }>(
    await runGetWorkItem({ key: epicKey }, c.ctx),
  );
  const asChild = mcpParent.children.find((ch) => ch.identifier === storyKey);
  expect(asChild).toBeDefined();
  const ai = await aiRows(c, epicKey);
  return {
    'REST v1 detail': markOf(await restDetail(c, storyKey)),
    'REST v1 collection row': markOf(pick(await restCollection(c), storyKey)),
    'MCP get_work_item item': markOf(mcpGet.item),
    'MCP get_work_item child row': markOf(asChild!),
    'MCP search_work_items row': markOf(pick(await mcpSearch(c), storyKey)),
    'MCP skeleton row': [pick(await mcpSkeleton(c), storyKey).obsolescence, null],
    'MCP list_ready row (leaf)': markOf(pick(await mcpReady(c), leafKey)),
    'internal get-item': markOf(await aiGetItem(c, storyKey)),
    'internal search-work-items row': [pick(ai['search-work-items']!, storyKey).obsolescence, null],
    'internal plan-tree row': [pick(ai['plan-tree']!, storyKey).obsolescence, null],
    'internal get-subtree node': [pick(ai['get-subtree']!, storyKey).obsolescence, null],
  };
}

describe('one mark, every door', () => {
  it('written on a DONE story over MCP update_work_item, read back identically everywhere; cleared over REST PATCH, null everywhere', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const epic = await create(c, 'epic', 'The import epic');
    const story = await create(c, 'story', 'Import via the v1 wizard', epic.id);
    const leaf = await create(c, 'task', 'Map the v1 columns', epic.id);
    await create(c, 'task', 'An unmarked neighbour', epic.id);
    await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'done' } });
    const keys = { epicKey: epic.identifier, storyKey: story.identifier, leafKey: leaf.identifier };

    const res = await runUpdateWorkItem(
      { key: story.identifier, obsolescence: 'outdated', obsolescenceNoteMd: NOTE },
      c.ctx,
    );
    expect(structured<Mark & { status: string }>(res).obsolescence).toBe('outdated');
    // The LEAF stands in for the `list_ready` read, and a card in the ready set is
    // unfinished, so no door may mark it any more (MOTIR-6672). It is seeded as a
    // LEGACY row — one marked before that rule — which the story does not migrate
    // and every read must still carry.
    await adminDb.workItem.update({
      where: { id: leaf.id },
      data: { obsolescence: 'outdated', obsolescenceNoteMd: NOTE },
    });
    // The write left the done story done.
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'done',
    );

    const full = ['outdated', NOTE];
    const markOnly = ['outdated', null];
    expect(await readEveryDoor(c, keys)).toEqual({
      'REST v1 detail': full,
      'REST v1 collection row': full,
      'MCP get_work_item item': full,
      'MCP get_work_item child row': full,
      'MCP search_work_items row': full,
      'MCP skeleton row': markOnly,
      'MCP list_ready row (leaf)': full,
      'internal get-item': full,
      'internal search-work-items row': markOnly,
      'internal plan-tree row': markOnly,
      'internal get-subtree node': markOnly,
    });

    // The service recorded the MCP write as a revision cell.
    const cells = (
      await adminDb.workItemRevision.findMany({
        where: { workItemId: story.id },
        orderBy: { changedAt: 'asc' },
        select: { diff: true },
      })
    )
      .map((r) => (r.diff as Record<string, unknown>)['obsolescence'])
      .filter(Boolean);
    expect(cells).toEqual([{ from: null, to: 'outdated' }]);

    // Cleared through a DIFFERENT door than the one that wrote it.
    for (const key of [story.identifier, leaf.identifier]) {
      const res = await restPatch(c, key, { obsolescence: null, obsolescenceNoteMd: null });
      expect(res.status).toBe(200);
    }
    const cleared = await readEveryDoor(c, keys);
    for (const [door, value] of Object.entries(cleared)) {
      expect([door, value]).toEqual([door, [null, null]]);
    }
  });
});

// ── one edge, every door ───────────────────────────────────────────────────

describe('one supersedes edge, every door', () => {
  it('linked over MCP `superseded_by`, read on BOTH ends by REST links, get_work_item and internal get-item; unlinked over MCP, empty everywhere', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const older = await create(c, 'story', 'The old import');
    const newer = await create(c, 'story', 'The new import');
    const [oldKey, newKey] = [older.identifier, newer.identifier];

    structured(
      await runLinkWorkItems(
        { fromKey: oldKey, toKey: newKey, relationship: 'superseded_by' },
        c.ctx,
      ),
    );
    // ONE row, stored newer → older.
    expect(
      await adminDb.workItemLink.findMany({ select: { fromId: true, toId: true, kind: true } }),
    ).toEqual([{ fromId: newer.id, toId: older.id, kind: 'supersedes' }]);

    const everyDoor = async () => {
      const mcpOld = structured<{
        supersedes: { item: { identifier: string } }[];
        supersededBy: { item: { identifier: string } }[];
      }>(await runGetWorkItem({ key: oldKey }, c.ctx));
      const mcpNew = structured<typeof mcpOld>(await runGetWorkItem({ key: newKey }, c.ctx));
      const ids = (g: { item: { identifier: string } }[]) => g.map((l) => l.item.identifier);
      const keysOf = (g: { key: string }[]) => g.map((r) => r.key);
      const [restOld, restNew] = [await restLinks(c, oldKey), await restLinks(c, newKey)];
      const [aiOld, aiNew] = [await aiGetItem(c, oldKey), await aiGetItem(c, newKey)];
      const restDetailOld = (await restDetail(c, oldKey)).links;
      return {
        'REST links (old)': [keysOf(restOld.supersedes), keysOf(restOld.supersededBy)],
        'REST links (new)': [keysOf(restNew.supersedes), keysOf(restNew.supersededBy)],
        'REST detail links (old)': [
          keysOf(restDetailOld.supersedes),
          keysOf(restDetailOld.supersededBy),
        ],
        'MCP get_work_item (old)': [ids(mcpOld.supersedes), ids(mcpOld.supersededBy)],
        'MCP get_work_item (new)': [ids(mcpNew.supersedes), ids(mcpNew.supersededBy)],
        'internal get-item (old)': [ids(aiOld.supersedes), ids(aiOld.supersededBy)],
        'internal get-item (new)': [ids(aiNew.supersedes), ids(aiNew.supersededBy)],
      };
    };

    const onOld = [[], [newKey]];
    const onNew = [[oldKey], []];
    expect(await everyDoor()).toEqual({
      'REST links (old)': onOld,
      'REST links (new)': onNew,
      'REST detail links (old)': onOld,
      'MCP get_work_item (old)': onOld,
      'MCP get_work_item (new)': onNew,
      'internal get-item (old)': onOld,
      'internal get-item (new)': onNew,
    });

    // The edge gates nothing: both ends are still ready.
    for (const id of [older.id, newer.id]) {
      expect(await workItemsService.isReady(id, c.ctx)).toBe(true);
    }

    const removed = structured<{ removed: boolean }>(
      await runUnlinkWorkItems(
        { fromKey: oldKey, toKey: newKey, relationship: 'superseded_by' },
        c.ctx,
      ),
    );
    expect(removed.removed).toBe(true);
    const empty = [[], []];
    expect(await everyDoor()).toEqual({
      'REST links (old)': empty,
      'REST links (new)': empty,
      'REST detail links (old)': empty,
      'MCP get_work_item (old)': empty,
      'MCP get_work_item (new)': empty,
      'internal get-item (old)': empty,
      'internal get-item (new)': empty,
    });
    expect(await adminDb.workItemLink.count()).toBe(0);
  });

  it('the same edge written over REST from the newer end reads identically, and a REST DELETE removes it', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const older = await create(c, 'task', 'Old');
    const newer = await create(c, 'task', 'New');
    const res = await restLink(c, newer.identifier, {
      toKey: older.identifier,
      relationship: 'supersedes',
    });
    expect(res.status).toBe(201);
    expect((await restLinks(c, older.identifier)).supersededBy.map((r) => r.key)).toEqual([
      newer.identifier,
    ]);
    expect(
      structured<{ supersedes: { item: { identifier: string } }[] }>(
        await runGetWorkItem({ key: newer.identifier }, c.ctx),
      ).supersedes.map((l) => l.item.identifier),
    ).toEqual([older.identifier]);

    // Deleted from the OTHER end with the inverse relationship — one edge, two names.
    const del = await restUnlink(c, older.identifier, {
      toKey: newer.identifier,
      relationship: 'superseded_by',
    });
    expect(del.status).toBe(204);
    expect(await adminDb.workItemLink.count()).toBe(0);
  });
});

// ── every kind, every status ───────────────────────────────────────────────

describe('the mark on every kind of finished card changes nothing else', () => {
  it('an epic, a story, a task, a bug and a subtask — done, cancelled, one archived — each take the mark; status, archivedAt, readiness and the parent rollup hold', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const epic = await create(c, 'epic', 'Epic');
    const story = await create(c, 'story', 'Story', epic.id);
    const subtask = await create(c, 'subtask', 'Subtask', story.id);
    const task = await create(c, 'task', 'Task', epic.id);
    const bug = await create(c, 'bug', 'Bug', epic.id);
    // A blocker so readiness is a real verdict (false) on one card, not a constant.
    const blocker = await create(c, 'task', 'Blocker');
    await workItemsService.linkWorkItems(
      { fromId: task.id, toId: blocker.id, kind: 'is_blocked_by' },
      c.ctx,
    );
    // Every card FINISHED (MOTIR-6672: a mark is a finished card's state) — across
    // both done-category statuses — so the mark is the only thing that changes.
    await adminDb.workItem.update({ where: { id: subtask.id }, data: { status: 'done' } });
    await adminDb.workItem.update({ where: { id: bug.id }, data: { status: 'cancelled' } });
    await adminDb.workItem.update({ where: { id: task.id }, data: { status: 'done' } });
    await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'cancelled' } });
    await adminDb.workItem.update({ where: { id: epic.id }, data: { status: 'done' } });
    await workItemsService.archiveWorkItem(story.id, c.ctx);

    const all = [epic, story, subtask, task, bug];
    // Converge every parent's derived status FIRST, so a later difference could
    // only be the mark's doing.
    for (const child of all) {
      await parentStatusRollupService.rollUpForChild(child.id, c.fixture.workspaceId);
    }
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const it of all) {
        const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: it.id } });
        out[it.identifier] = {
          kind: row.kind,
          status: row.status,
          archivedAt: row.archivedAt?.toISOString() ?? null,
          parentId: row.parentId,
          ready: await workItemsService.isReady(it.id, c.ctx),
        };
      }
      return out;
    };
    const before = await snapshot();
    expect(Object.values(before).map((s) => (s as { status: string }).status)).toEqual(
      expect.arrayContaining(['done', 'cancelled']),
    );
    expect((before[story.identifier] as { archivedAt: string | null }).archivedAt).not.toBeNull();

    for (const it of all) {
      const res = await runUpdateWorkItem(
        {
          key: it.identifier,
          obsolescence: 'deprecated',
          obsolescenceNoteMd: `Retired ${it.kind}`,
        },
        c.ctx,
      );
      expect(structured<Mark>(res).obsolescence).toBe('deprecated');
    }
    for (const child of all) {
      const outcome = await parentStatusRollupService.rollUpForChild(
        child.id,
        c.fixture.workspaceId,
      );
      expect(['rolled_up', 'rolled_back']).not.toContain(outcome.outcome);
    }

    expect(await snapshot()).toEqual(before);
    const stored = await adminDb.workItem.findMany({
      where: { id: { in: all.map((i) => i.id) } },
      select: { obsolescence: true, obsolescenceNoteMd: true, kind: true },
    });
    expect(stored).toHaveLength(5);
    for (const row of stored) {
      expect([row.obsolescence, row.obsolescenceNoteMd]).toEqual([
        'deprecated',
        `Retired ${row.kind}`,
      ]);
    }

    // Unarchiving leaves the mark as it was.
    await workItemsService.unarchiveWorkItem(story.id, c.ctx);
    expect((await restDetail(c, story.identifier)).obsolescence).toBe('deprecated');
  });
});

// ── the refusals ───────────────────────────────────────────────────────────

describe('the refusals', () => {
  it('a value outside the enum is the typed INVALID_OBSOLESCENCE on the service, REST (422) and MCP — writing nothing', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const task = await create(c, 'task', 'Target');

    await expect(
      workItemsService.updateWorkItem(task.id, { obsolescence: 'stale' as never }, c.ctx),
    ).rejects.toBeInstanceOf(InvalidObsolescenceError);

    expect(await refusal(await restPatch(c, task.identifier, { obsolescence: 'stale' }))).toEqual({
      status: 422,
      code: 'INVALID_OBSOLESCENCE',
    });
    expect(
      await refusal(await restCreate(c, { kind: 'task', title: 'x', obsolescence: 'obsolete' })),
    ).toEqual({ status: 422, code: 'INVALID_OBSOLESCENCE' });

    const mcp = await runUpdateWorkItem(
      { key: task.identifier, obsolescence: 'stale' as never },
      c.ctx,
    );
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp.content)).toContain('INVALID_OBSOLESCENCE');

    expect(await adminDb.workItem.count()).toBe(1);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.obsolescence).toBeNull();
  });

  it('a self supersedes link is refused on the service, REST and MCP', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const a = await create(c, 'story', 'A');

    await expect(
      workItemsService.linkWorkItems({ fromId: a.id, toId: a.id, kind: 'supersedes' }, c.ctx),
    ).rejects.toBeInstanceOf(SelfLinkError);
    const rest = await refusal(
      await restLink(c, a.identifier, { toKey: a.identifier, relationship: 'supersedes' }),
    );
    expect(rest.code).toBe('SELF_LINK');
    expect(rest.status).toBeGreaterThanOrEqual(400);
    expect(rest.status).toBeLessThan(500);
    const mcp = await runLinkWorkItems(
      { fromKey: a.identifier, toKey: a.identifier, relationship: 'superseded_by' },
      c.ctx,
    );
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp.content)).toContain('SELF_LINK');
    expect(await adminDb.workItemLink.count()).toBe(0);
  });

  it('a cross-workspace target is refused on REST and MCP, and no edge is written', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const other = await createV1ProjectCaller({
      permissions: [...EDITOR],
      workspaceName: 'Other Co',
      identifier: 'OTHER',
    });
    const mine = await create(c, 'story', 'Mine');
    const theirs = await create(other, 'story', 'Theirs');

    const rest = await restLink(c, mine.identifier, {
      toKey: theirs.identifier,
      relationship: 'supersedes',
    });
    expect(rest.status).toBe(404);
    const mcp = await runLinkWorkItems(
      { fromKey: mine.identifier, toKey: theirs.identifier, relationship: 'superseded_by' },
      c.ctx,
    );
    expect(mcp.isError).toBe(true);
    expect(JSON.stringify(mcp.content)).toMatch(/WORK_ITEM_NOT_FOUND|PROJECT_NOT_FOUND/);
    expect(await adminDb.workItemLink.count()).toBe(0);
  });
});

// ── nothing hides a marked card ────────────────────────────────────────────

describe('nothing hides or re-sorts a marked card', () => {
  it('the list, the tree, the board, the skeleton and the unfiltered search keep the marked row where it was, beside unmarked rows', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    // Five FINISHED root leaves (MOTIR-6672: only a finished card is marked); the
    // MIDDLE one gets marked, so a read that dropped it, or sorted marked rows
    // first or last, changes the sequence. The ready set is not among the reads:
    // a finished card is never in it, marked or not.
    const items: WorkItemDto[] = [];
    for (const title of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
      const item = await create(c, 'task', title);
      await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
      items.push(item);
    }
    const target = items[2]!;
    const sort = { column: 'key', direction: 'asc' } as const;

    const sixReads = async (): Promise<Record<string, string[]>> => {
      const list = await workItemsService.getProjectIssuesList(
        c.fixture.projectId,
        { sort },
        c.ctx,
      );
      const tree = await workItemsService.listRootIssues(c.fixture.projectId, { sort }, c.ctx);
      const board = await boardsService.getBoard(c.fixture.projectId, c.ctx);
      return {
        list: list.items.map((i) => i.identifier),
        tree: tree.rows.flatMap((r) => (r.kind === 'folder' ? [] : [r.identifier])),
        board: board.columns.flatMap((col) => col.cards.map((card) => card.identifier)),
        skeleton: (await mcpSkeleton(c)).map((r) => r.key),
        search: (await mcpSearch(c)).map((r) => r.key),
      };
    };

    // A board's DONE column orders by recency (`updatedAt`, the done-age window),
    // so ANY write moves a card to its top — a mark included. Touch the target
    // with a neutral edit first, so the only difference the reads below can see is
    // the mark itself.
    await workItemsService.updateWorkItem(target.id, { descriptionMd: 'Touched.' }, c.ctx);
    const before = await sixReads();
    for (const [read, keys] of Object.entries(before)) {
      expect([read, keys.length]).toEqual([read, 5]);
      expect([read, keys.includes(target.identifier)]).toEqual([read, true]);
    }

    structured(
      await runUpdateWorkItem(
        { key: target.identifier, obsolescence: 'deprecated', obsolescenceNoteMd: 'Retired.' },
        c.ctx,
      ),
    );

    const after = await sixReads();
    expect(after).toEqual(before);
    for (const [read, keys] of Object.entries(after)) {
      expect([read, keys.indexOf(target.identifier)]).toEqual([
        read,
        before[read]!.indexOf(target.identifier),
      ]);
    }
    // The marked row carries its mark and the unmarked ones do not — so the
    // equality above compared a MARKED set against an unmarked one.
    const rows = await mcpSearch(c);
    expect(rows.filter((r) => r.obsolescence !== null).map((r) => r.key)).toEqual([
      target.identifier,
    ]);
  });
});

// ── the filter ─────────────────────────────────────────────────────────────

describe('the obsolescence filter', () => {
  const only = (
    operator: 'is_any_of' | 'is_none_of' | 'is_empty' | 'is_not_empty',
    value: string[] | null,
  ): FilterAst => ({
    combinator: 'and',
    conditions: [{ field: 'obsolescence', operator, value }],
  });

  it('search_work_items answers each operator over marks written through the doors; is_none_of includes the unset rows; a saved filter round-trips', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const outdated = await create(c, 'story', 'Outdated story');
    const deprecated = await create(c, 'task', 'Deprecated task');
    const unmarked = await create(c, 'task', 'Current task');
    for (const item of [outdated, deprecated]) {
      await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
    }
    // Written through two different doors — the filter reads the column either way.
    structured(
      await runUpdateWorkItem({ key: outdated.identifier, obsolescence: 'outdated' }, c.ctx),
    );
    expect((await restPatch(c, deprecated.identifier, { obsolescence: 'deprecated' })).status).toBe(
      200,
    );

    const keys = async (ast?: FilterAst) => (await mcpSearch(c, ast)).map((r) => r.key).sort();
    const [o, d, u] = [outdated.identifier, deprecated.identifier, unmarked.identifier];
    expect(await keys(only('is_any_of', ['outdated']))).toEqual([o]);
    expect(await keys(only('is_any_of', ['outdated', 'deprecated']))).toEqual([o, d].sort());
    expect(await keys(only('is_none_of', ['outdated']))).toEqual([d, u].sort());
    expect(await keys(only('is_empty', null))).toEqual([u]);
    expect(await keys(only('is_not_empty', null))).toEqual([o, d].sort());
    expect(await keys()).toEqual([o, d, u].sort());

    const ast = only('is_none_of', ['deprecated']);
    const saved = await savedFiltersService.create(
      c.projectKey,
      { name: 'Not deprecated', visibility: 'private', filterParam: encodeFilterParam(ast) },
      c.ctx,
    );
    const resolved = await savedFiltersService.resolve(c.projectKey, saved.id, c.ctx);
    expect(resolved.astError).toBeNull();
    expect(resolved.ast).toEqual(ast);
    expect(await keys(resolved.ast!)).toEqual([o, u].sort());
  });
});

// ── the contract guards ────────────────────────────────────────────────────

describe('the enumerations of the scale agree', () => {
  it('WORK_ITEM_OBSOLESCENCES, the Prisma enum, the REST schema, both MCP write schemas and the filter whitelist name the same members', () => {
    const expected = [...WORK_ITEM_OBSOLESCENCES].sort();
    const mcpEnum = (tool: 'create_work_item' | 'update_work_item') =>
      [
        ...((
          MCP_TOOL_INPUT_SCHEMAS[tool] as {
            properties: Record<string, { anyOf?: Array<{ enum?: string[] }> }>;
          }
        ).properties['obsolescence']?.anyOf?.find((b) => b.enum)?.enum ?? []),
      ].sort();

    expect({
      prisma: Object.values(WorkItemObsolescence).sort(),
      rest: [...obsolescenceSchema.options].sort(),
      restDetail: [...workItemDetailSchema.shape.obsolescence.unwrap().options].sort(),
      mcpCreate: mcpEnum('create_work_item'),
      mcpUpdate: mcpEnum('update_work_item'),
      filter: [
        ...(FILTER_FIELDS.find((f) => f.id === 'obsolescence')?.valueWhitelist ?? []),
      ].sort(),
    }).toEqual({
      prisma: expected,
      rest: expected,
      restDetail: expected,
      mcpCreate: expected,
      mcpUpdate: expected,
      filter: expected,
    });
  });
});
