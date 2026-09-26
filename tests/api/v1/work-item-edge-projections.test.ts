import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as GET_DETAIL } from '@/app/api/v1/work-items/[key]/route';
import { GET as GET_COLLECTION } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import {
  presentDependencyEdges,
  readinessSchema,
  workItemDetailSchema,
  workItemSummarySchema,
  type WorkItemDetail,
  type WorkItemSummary,
} from '@/lib/api/v1/workItems/schema';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The three FIELD PROJECTIONS (Story 11.7 · Subtask 11.7.2 — MOTIR-2236) against
// real Postgres: per-CHILD dependency edges on the detail read, per-ROW edges on
// the work-item collection, and the blocked ANCESTOR's title on readiness.
//
// Two properties carry the whole card and neither can be checked by reading the
// diff:
//
//   • The two transports must AGREE. Each assertion below compares the v1 body
//     to the MCP payload for the SAME row rather than to a hand-written literal,
//     so "the block v1 emits" and "the block an agent already reads" cannot be
//     different from day one — which is the drift Story 11.6 later makes
//     structurally impossible and this card must not create in the meantime.
//   • The projection must be BOUNDED. A per-row implementation passes a 3-child
//     fixture and is quadratic on a real story, so the count assertions drive a
//     child set and a page large enough that the per-row form would fail them.

const BASE = 'http://localhost:3000/api/v1';

/** A child set big enough that a per-row projection is unmistakable. */
const CHILD_COUNT = 12;

function detailReq(caller: V1ProjectCaller, key: string): Promise<Response> {
  return GET_DETAIL(new Request(`${BASE}/work-items/${key}`, { headers: caller.headers }), {
    params: Promise.resolve({ key }),
  });
}

function collectionReq(caller: V1ProjectCaller, query = ''): Promise<Response> {
  const key = caller.projectKey;
  return GET_COLLECTION(
    new Request(`${BASE}/projects/${key}/work-items${query}`, { headers: caller.headers }),
    { params: Promise.resolve({ projectKey: key }) },
  );
}

async function readDetail(caller: V1ProjectCaller, key: string): Promise<WorkItemDetail> {
  const res = await detailReq(caller, key);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkItemDetail;
}

async function readCollection(
  caller: V1ProjectCaller,
  query = '',
): Promise<{ items: WorkItemSummary[]; nextCursor: string | null }> {
  const res = await collectionReq(caller, query);
  expect(res.status).toBe(200);
  return (await res.json()) as { items: WorkItemSummary[]; nextCursor: string | null };
}

async function makeItem(
  caller: V1ProjectCaller,
  title: string,
  extra: { parentId?: string; kind?: 'task' | 'subtask' | 'story' } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: extra.kind ?? 'task',
      title,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
    },
    caller.ctx,
  );
}

function blockedBy(caller: V1ProjectCaller, fromId: string, toId: string) {
  return workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, caller.ctx);
}

/** The `structuredContent` an MCP tool call carries — the payload an agent reads. */
async function mcpPayload(
  run: Promise<{ structuredContent?: unknown }>,
): Promise<Record<string, unknown>> {
  return (await run).structuredContent as Record<string, unknown>;
}

interface EdgeBlock {
  blockedBy: { key: string; title: string; status: string }[];
  blocks: { key: string; title: string; status: string }[];
}

describe('presentDependencyEdges — the shared mapper', () => {
  it('is TOTAL over an id the batched read said nothing about', () => {
    // Unreachable through the routes — `getDependencyEdgesForItems` pre-seeds
    // every id it is asked about — but the default is what makes the two-empty-
    // arrays promise hold at the SCHEMA rather than at each of the eight call
    // sites, so it is worth one direct assertion.
    expect(presentDependencyEdges(undefined)).toEqual({ blockedBy: [], blocks: [] });
  });

  it('shapes each edge FIELD BY FIELD — an extra DTO property does not reach the wire', () => {
    const mapped = presentDependencyEdges({
      blockedBy: [{ key: 'PROD-1', title: 'T', status: 'todo', internalSecret: 'do-not-ship' }],
      blocks: [],
    } as unknown as Parameters<typeof presentDependencyEdges>[0]);

    expect(mapped.blockedBy).toEqual([{ key: 'PROD-1', title: 'T', status: 'todo' }]);
    expect(JSON.stringify(mapped)).not.toContain('do-not-ship');
  });
});

describe('projection 1 — per-CHILD dependency edges on the detail read', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('carries the block on every child, TOTAL, with the same key names the MCP tool emits', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    const first = await makeItem(caller, 'first', { parentId: parent.id, kind: 'subtask' });
    const second = await makeItem(caller, 'second', { parentId: parent.id, kind: 'subtask' });
    const lonely = await makeItem(caller, 'lonely', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, second.id, first.id);

    const detail = await readDetail(caller, parent.identifier);

    expect(() => workItemDetailSchema.parse(detail)).not.toThrow();

    const byKey = new Map(detail.children.map((child) => [child.key, child]));
    expect(byKey.get(second.identifier)?.dependencies).toEqual({
      blockedBy: [{ key: first.identifier, title: 'first', status: 'todo' }],
      blocks: [],
    });
    expect(byKey.get(first.identifier)?.dependencies).toEqual({
      blockedBy: [],
      blocks: [{ key: second.identifier, title: 'second', status: 'todo' }],
    });
    // TOTAL: an edge-free child gets two EMPTY arrays, never a missing key — a
    // typed client never branches on presence.
    expect(byKey.get(lonely.identifier)?.dependencies).toEqual({ blockedBy: [], blocks: [] });
  });

  it('emits the SAME block the MCP `get_work_item` tool emits for the same children', async () => {
    // Compared against the other transport rather than a literal: the two
    // surfaces are aligned through the SERVICE, and this is what makes that
    // alignment a property a test holds rather than a claim in a comment.
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    const a = await makeItem(caller, 'a', { parentId: parent.id, kind: 'subtask' });
    const b = await makeItem(caller, 'b', { parentId: parent.id, kind: 'subtask' });
    const c = await makeItem(caller, 'c', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, b.id, a.id);
    await blockedBy(caller, c.id, b.id);

    const detail = await readDetail(caller, parent.identifier);
    const payload = await mcpPayload(runGetWorkItem({ key: parent.identifier }, caller.ctx));
    const mcpChildren = payload['children'] as { identifier: string; dependencies: EdgeBlock }[];

    const v1ByKey = new Map(detail.children.map((child) => [child.key, child.dependencies]));
    expect(mcpChildren.length).toBeGreaterThan(0);
    for (const child of mcpChildren) {
      expect(v1ByKey.get(child.identifier)).toEqual(child.dependencies);
    }
  });

  it('projects the whole child set in ONE batched call, not one per child', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    for (let i = 0; i < CHILD_COUNT; i += 1) {
      await makeItem(caller, `child ${i}`, { parentId: parent.id, kind: 'subtask' });
    }
    const spy = vi.spyOn(workItemsService, 'getDependencyEdgesForItems');

    const detail = await readDetail(caller, parent.identifier);

    expect(detail.children).toHaveLength(CHILD_COUNT);
    // ONE call carrying EVERY child id — a per-child implementation would make
    // this CHILD_COUNT calls of one id each.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(CHILD_COUNT);
  });

  it('costs nothing on a childless item — the batched read short-circuits', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const leaf = await makeItem(caller, 'no children here');

    const detail = await readDetail(caller, leaf.identifier);

    expect(detail.children).toEqual([]);
  });
});

describe('projection 2 — per-ROW dependency edges on the work-item collection', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('carries the block on every row, and agrees with `search_work_items`', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const first = await makeItem(caller, 'do me first');
    const second = await makeItem(caller, 'waits on the first');
    await blockedBy(caller, second.id, first.id);

    const { items } = await readCollection(caller);

    for (const row of items) expect(() => workItemSummarySchema.parse(row)).not.toThrow();

    const byKey = new Map(items.map((row) => [row.key, row.dependencies]));
    expect(byKey.get(second.identifier)).toEqual({
      blockedBy: [{ key: first.identifier, title: 'do me first', status: 'todo' }],
      blocks: [],
    });

    const payload = await mcpPayload(
      runSearchWorkItems({ projectKey: caller.projectKey }, caller.ctx),
    );
    const mcpRows = payload['items'] as { identifier: string; dependencies: EdgeBlock }[];
    expect(mcpRows.length).toBeGreaterThan(0);
    for (const row of mcpRows) {
      expect(byKey.get(row.identifier)).toEqual(row.dependencies);
    }
  });

  it("projects the whole page's edges in ONE batched call, not one per row", async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    for (let i = 0; i < CHILD_COUNT; i += 1) await makeItem(caller, `row ${i}`);
    const spy = vi.spyOn(workItemsService, 'getDependencyEdgesForItems');

    const { items } = await readCollection(caller);

    expect(items.length).toBe(CHILD_COUNT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(items.length);
  });

  it('scopes the projection to the PAGE, never to the whole collection', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    for (let i = 0; i < CHILD_COUNT; i += 1) await makeItem(caller, `row ${i}`);
    const spy = vi.spyOn(workItemsService, 'getDependencyEdgesForItems');

    const { items } = await readCollection(caller, '?limit=3');

    expect(items).toHaveLength(3);
    expect(spy.mock.calls[0]?.[0]).toHaveLength(3);
  });
});

describe("projection 3 — the blocked ANCESTOR's title", () => {
  beforeEach(async () => {
    await truncateAuthTables();
    vi.restoreAllMocks();
  });

  it('carries the title ALONGSIDE the still-published key', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const blocker = await makeItem(caller, 'the thing in the way');
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    const child = await makeItem(caller, 'the child', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, parent.id, blocker.id);

    const detail = await readDetail(caller, child.identifier);

    expect(() => readinessSchema.parse(detail.readiness)).not.toThrow();
    expect(detail.readiness.ready).toBe(false);
    // §8: the key is published API and is unchanged. The title arrives BESIDE
    // it — the CLI's readiness line prints `<key> — <title>` and needs both.
    expect(detail.readiness.blockedByAncestorKey).toBe(parent.identifier);
    expect(detail.readiness.blockedByAncestorTitle).toBe('the parent');
  });

  it('leaves both null together when no ancestor blocks the item', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const item = await makeItem(caller, 'nothing above me');

    const detail = await readDetail(caller, item.identifier);

    expect(detail.readiness.blockedByAncestorKey).toBeNull();
    expect(detail.readiness.blockedByAncestorTitle).toBeNull();
  });

  it('reports the SAME ancestor the MCP `get_work_item` tool reports', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });
    const blocker = await makeItem(caller, 'the thing in the way');
    const parent = await makeItem(caller, 'the parent', { kind: 'story' });
    const child = await makeItem(caller, 'the child', { parentId: parent.id, kind: 'subtask' });
    await blockedBy(caller, parent.id, blocker.id);

    const detail = await readDetail(caller, child.identifier);
    const payload = await mcpPayload(runGetWorkItem({ key: child.identifier }, caller.ctx));
    const readiness = payload['readiness'] as {
      blockedByAncestor: { identifier: string; title: string } | null;
    };

    expect(detail.readiness.blockedByAncestorKey).toBe(readiness.blockedByAncestor?.identifier);
    expect(detail.readiness.blockedByAncestorTitle).toBe(readiness.blockedByAncestor?.title);
  });
});

describe('the emitted OpenAPI document', () => {
  it('carries all three new fields, so the published reference describes them', () => {
    // The drift guard proves a real response validates against its declared
    // schema; this proves the DOCUMENT a client generates from actually names
    // the fields. A projection nobody can find in the reference is half-shipped.
    const doc = JSON.stringify(emitOpenApiDocument());
    const components = (emitOpenApiDocument()['components'] as Record<string, unknown>)[
      'schemas'
    ] as Record<string, { properties?: Record<string, unknown> }>;

    // Projection 2 — the collection row.
    expect(components['WorkItemSummary']?.properties).toHaveProperty('dependencies');
    // Projections 1 and 3 — the detail's children and its readiness verdict.
    const detail = components['WorkItemDetail']?.properties as Record<
      string,
      { items?: { properties?: Record<string, unknown> }; properties?: Record<string, unknown> }
    >;
    expect(detail['children']?.items?.properties).toHaveProperty('dependencies');
    expect(detail['readiness']?.properties).toHaveProperty('blockedByAncestorKey');
    expect(detail['readiness']?.properties).toHaveProperty('blockedByAncestorTitle');
    // The edge entries are named by their MOTIR-<n> key, never an internal id.
    expect(doc).toContain('blockedBy');
  });
});
