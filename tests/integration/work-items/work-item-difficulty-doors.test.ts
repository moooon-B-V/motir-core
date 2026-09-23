import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkItemDifficulty } from '@/generated/prisma/client';
import { POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET as LIST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET, PATCH } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { MCP_TOOL_INPUT_SCHEMAS } from '@/lib/apiDocs/mcpToolSchemas';
import { db } from '@/lib/db';
import { encodeFilterParam, FILTER_PARAM, type FilterAst } from '@/lib/filters/ast';
import { FILTER_FIELDS } from '@/lib/filters/registry';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { runChangeKind } from '@/lib/mcp/tools/changeKind';
import { runCreateWorkItem } from '@/lib/mcp/tools/createWorkItem';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import type { ProjectContext } from '@/lib/projects';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-6016 · MOTIR-6102 — the story's INTEGRATION gate. ONE difficulty
// value travels through every door the story opened, against the real
// database: written by one door and read back by the others, with the
// container refusal asserted at every write door (the row unchanged after).
// Each feature card's own units mock the adjacent layer; this file is the
// writer-to-consumer round trip they cannot see.

// The item-page server action reads the session and the active project; the
// session is the one mock CLAUDE.md allows, the project context is its twin.
const session = { current: null as null | { user: { id: string; email: string; name: string } } };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
const { updateIssueAction } = await import('@/app/(authed)/items/[key]/edit/actions');

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  resetRateLimitStore();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the doors ──────────────────────────────────────────────────────────────

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
async function restGet(c: V1ProjectCaller, key: string) {
  const res = await GET(new Request(`${BASE}/work-items/${key}`, { headers: c.headers }), {
    params: Promise.resolve({ key }),
  });
  expect(res.status).toBe(200);
  return workItemDetailSchema.parse(await res.json());
}
async function restSearchKeys(c: V1ProjectCaller, ast: FilterAst): Promise<string[]> {
  const url = new URL(`${BASE}/projects/${c.projectKey}/work-items`);
  url.searchParams.set(FILTER_PARAM, encodeFilterParam(ast));
  const res = await LIST(new Request(url, { headers: c.headers }), {
    params: Promise.resolve({ projectKey: c.projectKey }),
  });
  const body = (await res.json()) as {
    items?: Array<{ key: string }>;
    data?: Array<{ key: string }>;
  };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return (body.items ?? body.data ?? []).map((i) => i.key);
}
async function mcpSearchKeys(c: V1ProjectCaller, ast: FilterAst): Promise<string[]> {
  const res = await runSearchWorkItems(
    { projectKey: c.projectKey, filter: { version: 'v1', ...ast } } as never,
    c.ctx,
  );
  expect(res.isError).toBeFalsy();
  return (res.structuredContent as { items: Array<{ key: string }> }).items.map((i) => i.key);
}
async function refusal(res: Response): Promise<{ status: number; code: string }> {
  const body = (await res.json()) as { code: string };
  return { status: res.status, code: body.code };
}
async function storedDifficulty(key: string): Promise<string | null> {
  const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
  return row.difficulty;
}
function signIn(c: V1ProjectCaller): void {
  const owner = c.fixture.owner;
  session.current = { user: { id: owner.id, email: owner.email, name: owner.name ?? 'Owner' } };
  activeCtx.current = {
    userId: owner.id,
    workspaceId: c.fixture.workspaceId,
    projectId: c.fixture.projectId,
    project: c.fixture.project,
  } as ProjectContext;
}
const is = (operator: FilterAst['conditions'][number]['operator'], value: string[] | null) => ({
  combinator: 'and' as const,
  conditions: [{ field: 'difficulty' as const, operator, value }],
});

async function story(c: V1ProjectCaller) {
  const res = await restCreate(c, { kind: 'story', title: 'The story' });
  expect(res.status).toBe(201);
  return workItemDetailSchema.parse(await res.json());
}

// ── the round trips ────────────────────────────────────────────────────────

describe('one value, every door', () => {
  it('written via REST, read back identically by REST, MCP, the service, the quick view, both searches and the prompt', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const parent = await story(c);
    const created = await restCreate(c, {
      kind: 'subtask',
      title: 'Reorder the lock acquisition',
      parentKey: parent.key,
      difficulty: 'high',
    });
    expect(created.status).toBe(201);
    const key = workItemDetailSchema.parse(await created.json()).key;
    await restCreate(c, { kind: 'task', title: 'A distractor', difficulty: 'low' });

    expect((await restGet(c, key)).difficulty).toBe('high');

    const mcp = await runGetWorkItem({ key }, c.ctx);
    expect((mcp.structuredContent as { item: { difficulty: string } }).item.difficulty).toBe(
      'high',
    );

    const svc = await workItemsService.getWorkItemByIdentifier(c.fixture.projectId, key, c.ctx);
    expect(svc.difficulty).toBe('high');

    const qv = await workItemsService.getQuickView(c.fixture.projectId, key, 'open', c.ctx, 'en');
    expect(qv.difficulty).toBe('high');

    expect(await restSearchKeys(c, is('is_any_of', ['high']))).toEqual([key]);
    expect(await mcpSearchKeys(c, is('is_any_of', ['high']))).toEqual([key]);

    const { prompt } = await dispatchPromptService.getDispatchPrompt(
      c.fixture.projectId,
      key,
      c.ctx,
    );
    expect(prompt.match(/^- Difficulty: .*$/gm)).toEqual([
      expect.stringMatching(/^- Difficulty: high\b/),
    ]);
  });

  it('written via MCP, read via REST; each change is one activity entry; a REST clear empties it everywhere', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const task = await runCreateWorkItem(
      { projectKey: c.projectKey, kind: 'task', title: 'Via MCP', difficulty: 'medium' },
      c.ctx,
    );
    const key = (task.structuredContent as { identifier: string }).identifier;

    const low = await runUpdateWorkItem({ key, difficulty: 'low' }, c.ctx);
    expect(low.isError).toBeFalsy();
    expect((await restGet(c, key)).difficulty).toBe('low');

    const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
    const cells = (
      await adminDb.workItemRevision.findMany({
        where: { workItemId: row.id },
        orderBy: { changedAt: 'asc' },
        select: { diff: true },
      })
    )
      .map((r) => (r.diff as Record<string, unknown>)['difficulty'])
      .filter(Boolean);
    expect(cells).toEqual([
      { from: null, to: 'medium' },
      { from: 'medium', to: 'low' },
    ]);

    const cleared = await restPatch(c, key, { difficulty: null });
    expect(cleared.status).toBe(200);
    expect(await storedDifficulty(key)).toBeNull();
    expect(await restSearchKeys(c, is('is_empty', null))).toContain(key);
    const { prompt } = await dispatchPromptService.getDispatchPrompt(
      c.fixture.projectId,
      key,
      c.ctx,
    );
    expect(prompt).not.toMatch(/difficulty/i);
  });
});

// ── the refusals ───────────────────────────────────────────────────────────

describe('a container refuses a difficulty on every write door, and nothing changes', () => {
  it('REST POST and PATCH answer 422 DIFFICULTY_NOT_ALLOWED_ON_KIND', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    for (const kind of ['epic', 'story']) {
      expect(await refusal(await restCreate(c, { kind, title: 'C', difficulty: 'low' }))).toEqual({
        status: 422,
        code: 'DIFFICULTY_NOT_ALLOWED_ON_KIND',
      });
    }
    expect(await adminDb.workItem.count()).toBe(0);
    const parent = await story(c);
    expect(await refusal(await restPatch(c, parent.key, { difficulty: 'high' }))).toEqual({
      status: 422,
      code: 'DIFFICULTY_NOT_ALLOWED_ON_KIND',
    });
    expect(await storedDifficulty(parent.key)).toBeNull();
  });

  it('MCP create and update answer the typed refusal', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const created = await runCreateWorkItem(
      { projectKey: c.projectKey, kind: 'story', title: 'C', difficulty: 'medium' },
      c.ctx,
    );
    expect(created.isError).toBe(true);
    expect(JSON.stringify(created.content)).toContain('DIFFICULTY_NOT_ALLOWED_ON_KIND');
    expect(await adminDb.workItem.count()).toBe(0);

    const parent = await story(c);
    const updated = await runUpdateWorkItem({ key: parent.key, difficulty: 'medium' }, c.ctx);
    expect(updated.isError).toBe(true);
    expect(JSON.stringify(updated.content)).toContain('DIFFICULTY_NOT_ALLOWED_ON_KIND');
    expect(await storedDifficulty(parent.key)).toBeNull();
  });

  it('the item-page server action refuses it too', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const parent = await story(c);
    const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: parent.key } });
    signIn(c);
    const res = await updateIssueAction({ id: row.id, difficulty: 'high' } as never);
    expect(res.ok).toBe(false);
    expect(await storedDifficulty(parent.key)).toBeNull();
  });

  it('a kind change onto a container that keeps a difficulty is refused on REST and MCP alike', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const epic = await restCreate(c, { kind: 'epic', title: 'E' });
    const epicKey = workItemDetailSchema.parse(await epic.json()).key;
    const task = await restCreate(c, {
      kind: 'task',
      title: 'Carries one',
      parentKey: epicKey,
      difficulty: 'medium',
    });
    const key = workItemDetailSchema.parse(await task.json()).key;

    expect(await refusal(await restPatch(c, key, { kind: 'story' }))).toEqual({
      status: 422,
      code: 'DIFFICULTY_NOT_ALLOWED_ON_KIND',
    });
    const viaMcp = await runChangeKind({ key, kind: 'story' }, c.ctx);
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp.content)).toContain('DIFFICULTY_NOT_ALLOWED_ON_KIND');
    const row = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
    expect(row.kind).toBe('task');
    expect(row.difficulty).toBe('medium');
  });
});

// ── the membership guard ───────────────────────────────────────────────────

describe('the five enumerations of the scale agree', () => {
  it('the list, the Prisma enum, the REST schema, the MCP schema and the filter whitelist name the same members', () => {
    const expected = [...WORK_ITEM_DIFFICULTIES].sort();

    const prisma = Object.values(WorkItemDifficulty).sort();

    const restInner = workItemDetailSchema.shape.difficulty.unwrap();
    const rest = [...restInner.options].sort();

    const mcpProp = (
      MCP_TOOL_INPUT_SCHEMAS.create_work_item as {
        properties: Record<string, { anyOf?: Array<{ enum?: string[] }> }>;
      }
    ).properties['difficulty'];
    const mcp = [...(mcpProp?.anyOf?.find((b) => b.enum)?.enum ?? [])].sort();

    const filter = [
      ...(FILTER_FIELDS.find((f) => f.id === 'difficulty')?.valueWhitelist ?? []),
    ].sort();

    expect({ prisma, rest, mcp, filter }).toEqual({
      prisma: expected,
      rest: expected,
      mcp: expected,
      filter: expected,
    });
  });
});
