import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// POST /api/v1/work-items/{key}/archive and /restore
// (Story 11.2 · Subtask 11.2.10 — MOTIR-2052).

type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  modulePath: string,
  method: 'GET' | 'POST' | 'DELETE',
  key: string,
  caller: { headers: Record<string, string> },
  opts: { body?: unknown; query?: string } = {},
): Promise<Response> {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, Handler>;
  const handler = mod[method];
  if (!handler) throw new Error(`${modulePath} exports no ${method}`);
  const url = `http://localhost:3000/api/v1/work-items/${key}/x${opts.query ?? ''}`;
  return handler(
    new Request(url, {
      method,
      headers: { ...caller.headers, 'content-type': 'application/json' },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve({ key }) },
  );
}

const ARCHIVE = '@/app/api/v1/work-items/[key]/archive/route';
const RESTORE = '@/app/api/v1/work-items/[key]/restore/route';

// ─────────────────────────────────────────────────────────────────────────────
// 11.2.10 — archive / restore
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/v1/work-items/{key}/archive and /restore', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'work_items:archive'],
    });
  });

  it('archives and restores, asserted by reading the row back', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Removable' });

    const archived = await call(ARCHIVE, 'POST', item.identifier, caller);
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ archivedAt: expect.any(String) });
    expect((await db.workItem.findUnique({ where: { id: item.id } }))?.archivedAt).not.toBeNull();

    const restored = await call(RESTORE, 'POST', item.identifier, caller);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ archivedAt: null });
    expect((await db.workItem.findUnique({ where: { id: item.id } }))?.archivedAt).toBeNull();
  });

  it('does NOT touch children — archive is single-node', async () => {
    const parent = await createTestWorkItem(caller.fixture, { kind: 'story', title: 'Parent' });
    const child = await createTestWorkItem(caller.fixture, {
      kind: 'subtask',
      title: 'Child',
      parentId: parent.id,
    });

    await call(ARCHIVE, 'POST', parent.identifier, caller);

    expect((await db.workItem.findUnique({ where: { id: child.id } }))?.archivedAt).toBeNull();
  });

  it('an archived item LEAVES the collection and returns on restore', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Vanishing' });
    const { GET } = await import('@/app/api/v1/projects/[projectKey]/work-items/route');
    const list = async (): Promise<string[]> => {
      const res = await GET(
        new Request(
          `http://localhost:3000/api/v1/projects/${caller.projectKey}/work-items?limit=100`,
          { headers: caller.headers },
        ),
        { params: Promise.resolve({ projectKey: caller.projectKey }) },
      );
      const body = (await res.json()) as { items: Array<{ key: string }> };
      return body.items.map((i) => i.key);
    };

    expect(await list()).toContain(item.identifier);
    await call(ARCHIVE, 'POST', item.identifier, caller);
    // Asserted THROUGH the endpoints — the behaviour a client actually observes.
    expect(await list()).not.toContain(item.identifier);
    await call(RESTORE, 'POST', item.identifier, caller);
    expect(await list()).toContain(item.identifier);
  });

  it('both endpoints are IDEMPOTENT', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });

    expect((await call(ARCHIVE, 'POST', item.identifier, caller)).status).toBe(200);
    expect((await call(ARCHIVE, 'POST', item.identifier, caller)).status).toBe(200);
    expect((await call(RESTORE, 'POST', item.identifier, caller)).status).toBe(200);
    expect((await call(RESTORE, 'POST', item.identifier, caller)).status).toBe(200);
  });

  // ⚠️ The narrowing rule, proven in BOTH directions.
  it('403s a token with work_items:write but NOT work_items:archive', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });
    const writer = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });

    expect((await call(ARCHIVE, 'POST', item.identifier, writer)).status).toBe(403);
    expect((await call(RESTORE, 'POST', item.identifier, writer)).status).toBe(403);
  });

  it('refuses an archive-scoped token whose owner lacks project EDIT rights', async () => {
    // The other direction: the scope is an ADDITIONAL condition, never a
    // replacement for the role the service checks.
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'T' });
    const outsider = await createV1ProjectCaller({
      scopes: ['read', 'work_items:archive'],
      workspaceName: 'Outside',
      identifier: 'OUTS',
    });

    const res = await call(ARCHIVE, 'POST', item.identifier, outsider);

    expect(res.status).not.toBe(200);
    expect([403, 404]).toContain(res.status);
  });

  it('404s an unknown and a cross-tenant key on both endpoints', async () => {
    const other = await createV1ProjectCaller({
      scopes: ['read', 'work_items:archive'],
      workspaceName: 'Theirs',
      identifier: 'OTHR',
    });
    const theirs = await createTestWorkItem(other.fixture, { kind: 'task', title: 'Theirs' });

    expect((await call(ARCHIVE, 'POST', `${caller.projectKey}-999999`, caller)).status).toBe(404);
    expect((await call(ARCHIVE, 'POST', theirs.identifier, caller)).status).toBe(404);
    expect((await call(RESTORE, 'POST', theirs.identifier, caller)).status).toBe(404);
  });

  it('the cascade DELETE is not reachable — no route calls it', async () => {
    // The omission is asserted so it cannot be undone by accident, which is the
    // ADR's own condition for leaving it out. (The full source sweep lives in
    // the story gate; this is the behavioural half.)
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Survivor' });
    await call(ARCHIVE, 'POST', item.identifier, caller);

    // Archived, NOT deleted — the row is still there and restorable.
    expect(await db.workItem.findUnique({ where: { id: item.id } })).not.toBeNull();
    await call(RESTORE, 'POST', item.identifier, caller);
    const restored = await workItemsService.getWorkItemByIdentifier(
      caller.fixture.projectId,
      item.identifier,
      caller.ctx,
    );
    expect(restored.archivedAt).toBeNull();
  });
});
