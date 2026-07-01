import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { POST as searchPOST } from '@/app/api/internal/ai/search-work-items/route';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (Subtask 7.5.2) — the `search_work_items` planner read tool
// end-to-end through the REAL route, against a real Postgres. It rides the
// SHIPPED 6.1.1 FilterAST + the `/items` List read, so the tests exercise: the
// FilterAST decode (an old version / structurally-bad AST → typed 422; an
// unknown field → FilterValidationError → 422), cursor pagination (deterministic
// pages, an empty terminal page past the tail), the request-shape 400s, and the
// SAME §4a-service-bearer + §4b-job-token auth + 404-not-403 cross-tenant posture
// as the 7.5.1 family (readbackDepthRoutes.test.ts).

const SERVICE_SECRET = 'core-callback-secret-test';

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function tokenFor(fx: Fx): string {
  return mintJobToken({
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    projectId: fx.projectId,
  });
}

function req(opts: { bearer?: string; token?: string; body?: unknown }): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request('http://core/api/internal/ai/search-work-items', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  });
}

describe('POST /api/internal/ai/search-work-items', () => {
  it('returns the matching skeleton projection for a FilterAST', async () => {
    const fx = await makeFixture();
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Alpha' },
      fx.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Beta', type: 'code', priority: 'high' },
      fx.ctx,
    );

    const res = await searchPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {
          filter: {
            version: 'v1',
            combinator: 'and',
            conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeNull();
    expect(body.items).toEqual([
      {
        key: task.identifier,
        kind: 'task',
        type: 'code',
        title: 'Beta',
        status: 'todo',
        priority: 'high',
      },
    ]);
  });

  it('searches the whole project when the filter is omitted', async () => {
    const fx = await makeFixture();
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A' },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'B' },
      fx.ctx,
    );

    const res = await searchPOST(req({ bearer: SERVICE_SECRET, token: tokenFor(fx) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it('pages deterministically with an opaque cursor and ends past the tail', async () => {
    const fx = await makeFixture();
    for (const title of ['One', 'Two', 'Three']) {
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title },
        fx.ctx,
      );
    }

    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    do {
      const res = await searchPOST(
        req({
          bearer: SERVICE_SECRET,
          token: tokenFor(fx),
          body: { limit: 1, ...(cursor ? { cursor } : {}) },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.items.length).toBeLessThanOrEqual(1);
      for (const i of body.items) seen.push(i.key);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    // Three items, one per page, no overlap, ascending by key (DEFAULT_SORT).
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    const nums = seen.map((k) => Number(k.split('-')[1]));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it('422s an unsupported FilterAST version (a typed taxonomy error)', async () => {
    const fx = await makeFixture();
    const res = await searchPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { filter: { version: 'v0', combinator: 'and', conditions: [] } },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('UNSUPPORTED_FILTER_VERSION');
  });

  it('422s a structurally-valid AST that fails registry validation (unknown field)', async () => {
    const fx = await makeFixture();
    const res = await searchPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: {
          filter: {
            version: 'v1',
            combinator: 'and',
            conditions: [{ field: 'nope', operator: 'is_any_of', value: ['x'] }],
          },
        },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('UNKNOWN_FILTER_FIELD');
  });

  it('400s a malformed cursor', async () => {
    const fx = await makeFixture();
    const res = await searchPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx), body: { cursor: 'not-a-real-cursor!!' } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEARCH_CURSOR');
  });

  it('400s an out-of-range limit', async () => {
    const fx = await makeFixture();
    const res = await searchPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx), body: { limit: 0 } }),
    );
    expect(res.status).toBe(400);
    const tooBig = await searchPOST(
      req({ bearer: SERVICE_SECRET, token: tokenFor(fx), body: { limit: 999 } }),
    );
    expect(tooBig.status).toBe(400);
  });

  it('400s a non-array conditions (bad request shape)', async () => {
    const fx = await makeFixture();
    const res = await searchPOST(
      req({
        bearer: SERVICE_SECRET,
        token: tokenFor(fx),
        body: { filter: { version: 'v1', combinator: 'and', conditions: 'nope' } },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('401s a missing service bearer', async () => {
    const fx = await makeFixture();
    const res = await searchPOST(req({ token: tokenFor(fx) }));
    expect(res.status).toBe(401);
  });

  it('404s a foreign-project token (cross-tenant, never a leak)', async () => {
    const a = await makeFixture();
    const b = await makeFixture();
    const foreign = mintJobToken({
      userId: a.ctx.userId,
      workspaceId: a.ctx.workspaceId,
      projectId: b.projectId,
    });
    const res = await searchPOST(req({ bearer: SERVICE_SECRET, token: foreign }));
    expect(res.status).toBe(404);
  });
});
