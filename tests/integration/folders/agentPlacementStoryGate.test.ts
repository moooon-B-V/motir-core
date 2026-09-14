import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Mock ONLY the motir-ai boundary client — the pre-plan read approve's
// repository-set derivation reaches for. Every project, folder, plan and work
// item below is real Postgres.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { DELETE as deleteFolderRoute } from '@/app/api/v1/folders/[folderId]/route';
import {
  GET as getWorkItemRoute,
  PATCH as patchWorkItemRoute,
} from '@/app/api/v1/work-items/[key]/route';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema, type WorkItemDetail } from '@/lib/api/v1/workItems/schema';
import { db } from '@/lib/db';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import { checkPayloadDrift } from '@/lib/mcp/payloads/driftGuard';
import { TOOL_PAYLOADS } from '@/lib/mcp/payloads/registry';
import { buildMcpServer } from '@/lib/mcp/registry';
import { ADD_PLAN_ITEMS_TOOL_NAME, CREATE_PLAN_TOOL_NAME } from '@/lib/mcp/tools/authorPlan';
import { LIST_READY_TOOL_NAME } from '@/lib/mcp/tools/listReady';
import { PlanRefGraphError } from '@/lib/plans/errors';
import { foldersService } from '@/lib/services/foldersService';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';

// THE STORY GATE for motir-core (Story MOTIR-5310 · MOTIR-5420).
//
// Every card of the story tested its own door. This file drives the doors
// TOGETHER, through the real surfaces an integration and an agent use — the
// `/api/v1` route handlers and an in-memory MCP client over `buildMcpServer` —
// so a seam where one card's output feeds another's cannot pass on the strength
// of each half alone.
//
//   1  ONE PLACEMENT, THREE READS — a PATCH files an item; the v1 detail, MCP
//      `get_work_item` and MCP `skeleton` agree on where it sits.
//   2  AGENT → PLAN → TREE — `create_folder`, then `add_plan_items` with an `add`
//      placed `folder:<id>` and a `modify` filing a committed epic; after approve,
//      `skeleton` shows both filed and the folder in `folders`.
//   3  A STALE PLAN — the folder a plan names is deleted over `/api/v1`; the
//      review model reads `folderMissing`, and approve refuses naming the folder
//      with nothing materialized.
//   4  READINESS IS TRANSPARENT to every new door — a ready leaf filed over
//      `/api/v1`, over `move_to_parent`, and by an approved plan stays in
//      `list_ready`; a blocked one stays out.
//
// APPROVE is `plansService.approvePlan`, the service the Motir approve route
// calls: no MCP tool approves a plan (approval asserts `ai:decide_plan`, which
// no tool carries), so a person in Motir is the only door, and the service is
// that door minus the session cookie.
//
// ⚠️ Guard 4 lives HERE, not in `pnpm test:guards`: that lane opens no database
// by construction (`vitest.guards.config.ts`, enforced by
// `tests/ci-structural-guards-lane.test.ts`), and readiness is a fact about rows.

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();
  spyOnJobDispatch();
  vi.mocked(getPreplanState).mockResolvedValue({
    session: null,
    docs: [],
    catalog: null,
  } as RawPreplanStateResponse);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the doors ────────────────────────────────────────────────────────────────

async function connect(ctx: ServiceContext): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'agent-placement-story-gate', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function tool<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  expect(res.isError, `${name}: ${text}`).toBeFalsy();
  return res.structuredContent as T;
}

async function v1Patch(
  caller: V1ProjectCaller,
  key: string,
  body: unknown,
): Promise<WorkItemDetail> {
  const res = await patchWorkItemRoute(
    new Request(`${BASE}/work-items/${key}`, {
      method: 'PATCH',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
  const json: unknown = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return workItemDetailSchema.parse(json);
}

async function v1Get(caller: V1ProjectCaller, key: string): Promise<WorkItemDetail> {
  const res = await getWorkItemRoute(
    new Request(`${BASE}/work-items/${key}`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
  const json: unknown = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(200);
  return workItemDetailSchema.parse(json);
}

async function v1DeleteFolder(caller: V1ProjectCaller, folderId: string): Promise<void> {
  const res = await deleteFolderRoute(
    new Request(`${BASE}/folders/${folderId}`, { method: 'DELETE', headers: caller.headers }),
    { params: Promise.resolve({ folderId }) },
  );
  expect(res.status, await res.clone().text()).toBe(200);
}

// ── reads ────────────────────────────────────────────────────────────────────

interface SkeletonOut {
  items: { key: string; folderId: string | null }[];
  folders: { id: string; parentFolderId: string | null; name: string; path: string[] }[];
  foldersTruncated: boolean;
}

interface GetWorkItemOut {
  folderId: string | null;
  folderPath: string[] | null;
}

function skeleton(client: Client, projectKey: string): Promise<SkeletonOut> {
  return tool<SkeletonOut>(client, 'skeleton', { projectKey });
}

async function readyIds(client: Client, projectKey: string): Promise<Set<string>> {
  const page = await tool<{ items: { id: string }[] }>(client, LIST_READY_TOOL_NAME, {
    projectKey,
    limit: 200,
  });
  return new Set(page.items.map((i) => i.id));
}

// ── seeds ────────────────────────────────────────────────────────────────────

async function seed(
  caller: V1ProjectCaller,
  title: string,
  kind: 'epic' | 'story' | 'task',
): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind, title },
    caller.ctx,
  );
  return { id: dto.id, key: dto.identifier };
}

async function mcpPlan(
  client: Client,
  projectKey: string,
  proposals: Record<string, unknown>[],
): Promise<string> {
  const plan = await tool<PlanWithItemsDto>(client, CREATE_PLAN_TOOL_NAME, {
    projectKey,
    title: 'File the parked work',
    plannedWithHarness: 'Claude Code',
    plannedWithModel: 'claude-opus-5',
  });
  await tool(client, ADD_PLAN_ITEMS_TOOL_NAME, { planId: plan.id, proposals, final: true });
  return plan.id;
}

// ── 1 · one placement, three reads ──────────────────────────────────────────

describe('seam 1 — one placement, three reads', () => {
  it('a PATCH files an epic; the v1 detail, get_work_item and skeleton agree on where it sits', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const client = await connect(caller.ctx);
    const parked = await foldersService.createFolder(
      { projectId: caller.fixture.projectId, parentFolderId: null, name: 'Parked' },
      caller.ctx,
    );
    const year = await foldersService.createFolder(
      { projectId: caller.fixture.projectId, parentFolderId: parked.id, name: '2025' },
      caller.ctx,
    );
    const epic = await seed(caller, 'Ideas', 'epic');

    const written = await v1Patch(caller, epic.key, { folderId: year.id });
    expect(written.folderId).toBe(year.id);

    const rest = await v1Get(caller, epic.key);
    const mcp = await tool<GetWorkItemOut>(client, 'get_work_item', { key: epic.key });
    const tree = await skeleton(client, caller.projectKey);

    expect(rest).toMatchObject({ folderId: year.id, folderPath: ['Parked', '2025'] });
    expect({ folderId: mcp.folderId, folderPath: mcp.folderPath }).toEqual({
      folderId: rest.folderId,
      folderPath: rest.folderPath,
    });
    expect(tree.items.find((r) => r.key === epic.key)?.folderId).toBe(rest.folderId);
    expect(tree.folders.find((f) => f.id === year.id)?.path).toEqual(rest.folderPath);
  });
});

// ── 2 · agent → plan → tree ─────────────────────────────────────────────────

describe('seam 2 — an agent files work into a folder through a plan', () => {
  it('create_folder, then an add placed folder:<id> and a modify filing an epic; after approve skeleton shows both filed', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const client = await connect(caller.ctx);
    const committed = await seed(caller, 'Old spike', 'epic');

    const folder = await tool<{ id: string }>(client, 'create_folder', {
      projectKey: caller.projectKey,
      name: 'Backlog ideas',
    });
    const planId = await mcpPlan(client, caller.projectKey, [
      {
        op: 'add',
        proposedFields: { title: 'Parked story', kind: 'story' },
        parentRef: `folder:${folder.id}`,
      },
      { op: 'modify', workItemId: committed.id, patch: { parentRef: `folder:${folder.id}` } },
    ]);

    await plansService.approvePlan(planId, caller.ctx);

    const tree = await skeleton(client, caller.projectKey);
    const story = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: caller.fixture.projectId, title: 'Parked story' },
    });
    const filed = new Map(tree.items.map((r) => [r.key, r.folderId]));
    expect(filed.get(story.identifier)).toBe(folder.id);
    expect(filed.get(committed.key)).toBe(folder.id);
    expect(tree.folders).toEqual([
      expect.objectContaining({ name: 'Bugs', path: ['Bugs'] }),
      expect.objectContaining({ id: folder.id, name: 'Backlog ideas', path: ['Backlog ideas'] }),
    ]);
  });
});

// ── 3 · a stale plan ────────────────────────────────────────────────────────

describe('seam 3 — the folder a plan names is deleted before approve', () => {
  it('the review model reads folderMissing, and approve refuses naming the folder with nothing materialized', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const client = await connect(caller.ctx);
    const folder = await tool<{ id: string }>(client, 'create_folder', {
      projectKey: caller.projectKey,
      name: 'Doomed',
    });
    const planId = await mcpPlan(client, caller.projectKey, [
      {
        op: 'add',
        proposedFields: { title: 'Never created', kind: 'story' },
        parentRef: `folder:${folder.id}`,
      },
    ]);

    await v1DeleteFolder(caller, folder.id);

    const review = await planReviewService.getPlanReview(planId, caller.ctx);
    const item = review.items.find((i) => i.title === 'Never created');
    expect(item).toMatchObject({ folderId: folder.id, folderPath: null, folderMissing: true });

    const refusal = await plansService.approvePlan(planId, caller.ctx).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(PlanRefGraphError);
    expect((refusal as PlanRefGraphError).message).toContain(`folder:${folder.id}`);

    const created = await adminDb.workItem.count({
      where: { projectId: caller.fixture.projectId, title: 'Never created' },
    });
    expect(created).toBe(0);
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('planned');
  });
});

// ── 4 · readiness is transparent to every new door ──────────────────────────

describe('guard — readiness is transparent to every new folder door', () => {
  it('a ready leaf filed over /api/v1, over move_to_parent and by an approved plan stays ready; a blocked one stays out', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const client = await connect(caller.ctx);
    const folder = await foldersService.createFolder(
      { projectId: caller.fixture.projectId, parentFolderId: null, name: 'Parked' },
      caller.ctx,
    );

    const viaRest = await seed(caller, 'Filed over REST', 'task');
    const viaMove = await seed(caller, 'Filed by move_to_parent', 'task');
    const viaPlan = await seed(caller, 'Filed by a plan', 'task');
    const blocker = await seed(caller, 'An open blocker', 'task');
    const blocked = await seed(caller, 'Blocked and filed', 'task');
    await workItemsService.linkWorkItems(
      { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
      caller.ctx,
    );

    const before = await readyIds(client, caller.projectKey);
    for (const leaf of [viaRest, viaMove, viaPlan]) expect(before.has(leaf.id)).toBe(true);
    expect(before.has(blocked.id)).toBe(false);

    await v1Patch(caller, viaRest.key, { folderId: folder.id });
    await v1Patch(caller, blocked.key, { folderId: folder.id });
    await tool(client, 'move_to_parent', { key: viaMove.key, folderId: folder.id });
    const planId = await mcpPlan(client, caller.projectKey, [
      { op: 'modify', workItemId: viaPlan.id, patch: { parentRef: `folder:${folder.id}` } },
    ]);
    await plansService.approvePlan(planId, caller.ctx);

    const rows = await adminDb.workItem.findMany({
      where: { id: { in: [viaRest.id, viaMove.id, viaPlan.id, blocked.id] } },
      select: { id: true, folderId: true },
    });
    for (const row of rows) expect(row.folderId).toBe(folder.id);

    const after = await readyIds(client, caller.projectKey);
    for (const leaf of [viaRest, viaMove, viaPlan]) expect(after.has(leaf.id)).toBe(true);
    expect(after.has(blocked.id)).toBe(false);
  });
});

// ── the folder WRITES answer in v1's own shapes ─────────────────────────────

describe('seam — the MCP folder writes return the /api/v1 resources, checked by the drift guard', () => {
  it('a real create_folder payload is v1 `Folder` and a real delete_folder payload is v1 `FolderDeletion`', async () => {
    const caller = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const client = await connect(caller.ctx);
    const parent = await tool<Record<string, unknown>>(client, 'create_folder', {
      projectKey: caller.projectKey,
      name: 'Parked',
    });
    const child = await tool<Record<string, unknown>>(client, 'create_folder', {
      projectKey: caller.projectKey,
      name: '2025',
      parentFolderId: parent.id,
    });
    const deletion = await tool<Record<string, unknown>>(client, 'delete_folder', {
      projectKey: caller.projectKey,
      folderId: parent.id,
    });

    expect(checkPayloadDrift(TOOL_PAYLOADS.create_folder!, child)).toEqual([]);
    expect(checkPayloadDrift(TOOL_PAYLOADS.delete_folder!, deletion)).toEqual([]);
    expect(deletion).toMatchObject({ deletedFolderId: parent.id, movedFolderIds: [child.id] });
    // …and the guard is not vacuous over them: a payload missing a field v1
    // requires is reported, by resource.
    const { path: _path, ...withoutPath } = child;
    expect(checkPayloadDrift(TOOL_PAYLOADS.create_folder!, withoutPath)).toEqual([
      expect.objectContaining({ resource: 'Folder' }),
    ]);
  });
});
