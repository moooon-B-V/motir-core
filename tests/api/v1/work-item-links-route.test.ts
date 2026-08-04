import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET + POST + DELETE /api/v1/work-items/{key}/links
// (Story 11.2 · Subtask 11.2.9 — MOTIR-2051).

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

const LINKS = '@/app/api/v1/work-items/[key]/links/route';

// ─────────────────────────────────────────────────────────────────────────────
// 11.2.9 — links
// ─────────────────────────────────────────────────────────────────────────────

interface LinkGroups {
  blockedBy: Array<{ key: string }>;
  blocks: Array<{ key: string }>;
  relatesTo: Array<{ key: string }>;
  duplicates: Array<{ key: string }>;
  clones: Array<{ key: string }>;
}

describe('GET + POST + DELETE /api/v1/work-items/{key}/links', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('returns ALL FIVE groups, empty ones as [] rather than absent keys', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Lonely' });

    const groups = (await (await call(LINKS, 'GET', item.identifier, caller)).json()) as LinkGroups;

    // An absent key and an empty group are DIFFERENT things to a typed client.
    expect(Object.keys(groups).sort()).toEqual([
      'blockedBy',
      'blocks',
      'clones',
      'duplicates',
      'relatesTo',
    ]);
    for (const value of Object.values(groups)) expect(value).toEqual([]);
  });

  it('a blocked_by edge shows as blockedBy on one side and blocks on the OTHER', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Dependent' });
    const blocker = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Blocker' });

    const created = await call(LINKS, 'POST', item.identifier, caller, {
      body: { toKey: blocker.identifier, relationship: 'blocked_by' },
    });
    expect(created.status).toBe(201);

    const mine = (await (await call(LINKS, 'GET', item.identifier, caller)).json()) as LinkGroups;
    const theirs = (await (
      await call(LINKS, 'GET', blocker.identifier, caller)
    ).json()) as LinkGroups;

    expect(mine.blockedBy.map((r) => r.key)).toEqual([blocker.identifier]);
    // The round trip a dependency-writing integration depends on.
    expect(theirs.blocks.map((r) => r.key)).toEqual([item.identifier]);
  });

  it('a relates_to edge shows on BOTH items (the shipped reciprocal)', async () => {
    const a = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'B' });

    await call(LINKS, 'POST', a.identifier, caller, {
      body: { toKey: b.identifier, relationship: 'relates_to' },
    });

    const fromA = (await (await call(LINKS, 'GET', a.identifier, caller)).json()) as LinkGroups;
    const fromB = (await (await call(LINKS, 'GET', b.identifier, caller)).json()) as LinkGroups;

    expect(fromA.relatesTo.map((r) => r.key)).toEqual([b.identifier]);
    expect(fromB.relatesTo.map((r) => r.key)).toEqual([a.identifier]);
  });

  it('the group shape is the SAME declaration the detail resource nests', async () => {
    const item = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Linked' });
    const other = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Other' });
    await call(LINKS, 'POST', item.identifier, caller, {
      body: { toKey: other.identifier, relationship: 'relates_to' },
    });

    const subResource = (await (
      await call(LINKS, 'GET', item.identifier, caller)
    ).json()) as LinkGroups;

    const { GET } = await import('@/app/api/v1/work-items/[key]/route');
    const detail = await (
      await GET(
        new Request(`http://localhost:3000/api/v1/work-items/${item.identifier}`, {
          headers: caller.headers,
        }),
        { params: Promise.resolve({ key: item.identifier }) },
      )
    ).json();

    expect(subResource).toEqual(detail.links);
  });

  it('DELETE is IDEMPOTENT — 204 on the second call, and on an edge that never existed', async () => {
    const a = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'B' });
    await call(LINKS, 'POST', a.identifier, caller, {
      body: { toKey: b.identifier, relationship: 'relates_to' },
    });

    const query = `?toKey=${b.identifier}&relationship=relates_to`;
    const first = await call(LINKS, 'DELETE', a.identifier, caller, { query });
    const second = await call(LINKS, 'DELETE', a.identifier, caller, { query });

    expect(first.status).toBe(204);
    // A retried teardown is safe — the post-condition holds either way.
    expect(second.status).toBe(204);

    const never = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'C' });
    const phantom = await call(LINKS, 'DELETE', a.identifier, caller, {
      query: `?toKey=${never.identifier}&relationship=clones`,
    });
    expect(phantom.status).toBe(204);

    const groups = (await (await call(LINKS, 'GET', a.identifier, caller)).json()) as LinkGroups;
    expect(groups.relatesTo).toEqual([]);
  });

  it('409s a DUPLICATE link, 422s a self-link', async () => {
    const a = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'B' });
    await call(LINKS, 'POST', a.identifier, caller, {
      body: { toKey: b.identifier, relationship: 'relates_to' },
    });

    const duplicate = await call(LINKS, 'POST', a.identifier, caller, {
      body: { toKey: b.identifier, relationship: 'relates_to' },
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ code: 'DUPLICATE_LINK' });

    const self = await call(LINKS, 'POST', a.identifier, caller, {
      body: { toKey: a.identifier, relationship: 'relates_to' },
    });
    expect(self.status).toBe(422);
    await expect(self.json()).resolves.toMatchObject({ code: 'SELF_LINK' });
  });

  it('404s a toKey in ANOTHER workspace — indistinguishable from one that never existed', async () => {
    const mine = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'Mine' });
    const other = await createV1ProjectCaller({ workspaceName: 'Theirs', identifier: 'OTHR' });
    const theirs = await createTestWorkItem(other.fixture, { kind: 'task', title: 'Theirs' });

    const foreign = await call(LINKS, 'POST', mine.identifier, caller, {
      body: { toKey: theirs.identifier, relationship: 'relates_to' },
    });
    const absent = await call(LINKS, 'POST', mine.identifier, caller, {
      body: { toKey: `${other.projectKey}-999999`, relationship: 'relates_to' },
    });

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
  });

  it('a read-only token gets 200 on GET and 403 on BOTH writes', async () => {
    const a = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'A' });
    const b = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'B' });
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    expect((await call(LINKS, 'GET', a.identifier, caller)).status).toBe(200);
    expect(
      (
        await call(LINKS, 'POST', a.identifier, readOnly, {
          body: { toKey: b.identifier, relationship: 'relates_to' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(LINKS, 'DELETE', a.identifier, readOnly, {
          query: `?toKey=${b.identifier}&relationship=relates_to`,
        })
      ).status,
    ).toBe(403);
  });

  it('422s a DELETE missing its query parameters', async () => {
    const a = await createTestWorkItem(caller.fixture, { kind: 'task', title: 'A' });

    const res = await call(LINKS, 'DELETE', a.identifier, caller);

    expect(res.status).toBe(422);
  });
});
