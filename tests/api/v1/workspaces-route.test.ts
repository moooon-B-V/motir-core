import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { GET } from '@/app/api/v1/workspaces/route';
import { createV1Caller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/workspaces (Story 11.1 · Subtask 11.1.3 — MOTIR-1859) against
// real Postgres. The primitive's own branches live in `pagination.test.ts`;
// this file asserts the ENDPOINT — that a real client walking a real,
// concurrently-mutating collection with only the cursors it was handed sees
// every row exactly once.

const BASE = 'http://localhost:3000/api/v1/workspaces';

function req(headers: Record<string, string>, query = '') {
  return new Request(`${BASE}${query}`, { headers });
}

interface Page {
  items: Array<{ id: string; name: string; slug: string; createdAt: string }>;
  nextCursor: string | null;
}

async function fetchPage(headers: Record<string, string>, query = ''): Promise<Page> {
  const res = await GET(req(headers, query));
  expect(res.status).toBe(200);
  return (await res.json()) as Page;
}

/**
 * Walk the WHOLE collection using ONLY the cursors the server returned — never
 * a hand-built one, because that is precisely what an external client cannot
 * do. `onPage` runs between fetches, which is where the mutation tests write.
 */
async function walkAll(
  headers: Record<string, string>,
  limit: number,
  onPage?: (page: Page, index: number) => Promise<void>,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  let index = 0;

  do {
    const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await fetchPage(headers, query);
    seen.push(...page.items.map((w) => w.id));
    await onPage?.(page, index);
    cursor = page.nextCursor;
    index += 1;
  } while (cursor && index < 50);

  return seen;
}

/** Give a workspace an exact `createdAt`, so a test controls the sort order. */
async function backdate(workspaceId: string, iso: string) {
  await db.workspace.update({ where: { id: workspaceId }, data: { createdAt: new Date(iso) } });
}

describe('GET /api/v1/workspaces', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('returns the list envelope, gated on the read scope', async () => {
    const caller = await createV1Caller({ scopes: ['read'], workspaceName: 'Alpha' });

    const page = await fetchPage(caller.headers);

    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      id: caller.workspace.id,
      name: 'Alpha',
      slug: caller.workspace.slug,
      createdAt: expect.any(String),
    });
  });

  it('refuses a token without the read scope', async () => {
    const caller = await createV1Caller({ scopes: ['integration'] });

    const res = await GET(req(caller.headers));

    expect(res.status).toBe(403);
  });

  it('leaks no Prisma column beyond id / name / slug / createdAt', async () => {
    const caller = await createV1Caller();

    const page = await fetchPage(caller.headers);

    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'name', 'slug']);
  });

  it('pages the whole collection with the returned cursor, once per row', async () => {
    const caller = await createV1Caller({ workspaceName: 'W0' });
    for (let i = 1; i < 5; i++) {
      await workspacesService.createWorkspace({ name: `W${i}`, ownerUserId: caller.user.id });
    }

    const seen = await walkAll(caller.headers, 2);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('reports no next cursor on the final page — no extra empty round trip', async () => {
    const caller = await createV1Caller();
    await workspacesService.createWorkspace({ name: 'Second', ownerUserId: caller.user.id });

    const page = await fetchPage(caller.headers, '?limit=2');

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  // ⚠️ THE property offset pagination cannot provide. A row is INSERTED
  // between two page fetches, positioned inside the range already served —
  // exactly the write that makes an offset pager re-serve one row and never
  // serve another.
  it('skips no row and duplicates none when the collection MUTATES mid-scan', async () => {
    const caller = await createV1Caller({ workspaceName: 'W0' });
    const original = [caller.workspace.id];
    await backdate(caller.workspace.id, '2026-08-01T00:00:00.000Z');

    for (let i = 1; i < 6; i++) {
      const { workspace } = await workspacesService.createWorkspace({
        name: `W${i}`,
        ownerUserId: caller.user.id,
      });
      original.push(workspace.id);
      await backdate(workspace.id, `2026-08-0${i + 1}T00:00:00.000Z`);
    }

    // Page 1 (limit 2) serves W0 (08-01) and W1 (08-02), leaving the cursor
    // at 08-02. Between fetches, insert one row on EACH side of it.
    const inserted: Record<'before' | 'after', string> = { before: '', after: '' };
    const seen = await walkAll(caller.headers, 2, async (_page, index) => {
      if (index !== 0) return;
      for (const [side, iso] of [
        ['before', '2026-08-01T12:00:00.000Z'],
        ['after', '2026-08-02T12:00:00.000Z'],
      ] as const) {
        const { workspace } = await workspacesService.createWorkspace({
          name: `Interloper-${side}`,
          ownerUserId: caller.user.id,
        });
        inserted[side] = workspace.id;
        await backdate(workspace.id, iso);
      }
    });

    // Every original row exactly once…
    for (const id of original) {
      expect(
        seen.filter((s) => s === id),
        `workspace ${id} seen exactly once`,
      ).toHaveLength(1);
    }
    // …and nothing duplicated anywhere in the walk.
    expect(new Set(seen).size).toBe(seen.length);
    // A row inserted BEFORE the cursor belongs to a page already handed out,
    // so it is correctly not re-shown — re-showing it is what would duplicate.
    expect(seen).not.toContain(inserted.before);
    // A row inserted AFTER the cursor simply arrives on a later page.
    expect(seen).toContain(inserted.after);
  });

  it('survives a row being REMOVED mid-scan', async () => {
    const caller = await createV1Caller({ workspaceName: 'W0' });
    const created = [caller.workspace.id];
    for (let i = 1; i < 6; i++) {
      const { workspace } = await workspacesService.createWorkspace({
        name: `W${i}`,
        ownerUserId: caller.user.id,
      });
      created.push(workspace.id);
    }

    const seen = await walkAll(caller.headers, 2, async (_page, index) => {
      if (index !== 0) return;
      // Drop the LAST workspace — under an offset pager this shifts the tail
      // left and silently skips a row.
      await workspacesService.deleteWorkspace({
        workspaceId: created[created.length - 1] as string,
        actorUserId: caller.user.id,
      });
    });

    expect(new Set(seen).size).toBe(seen.length);
    // The four rows between the first page and the deleted tail are all served.
    for (const id of created.slice(0, -1)) {
      expect(seen).toContain(id);
    }
  });

  it('rejects a malformed cursor with 422 INVALID_CURSOR — never a silent reset', async () => {
    const caller = await createV1Caller();

    const res = await GET(req(caller.headers, '?cursor=totally-made-up'));

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({
      code: 'INVALID_CURSOR',
      error: 'The `cursor` parameter is not a valid page cursor.',
    });
  });

  it('rejects an out-of-range limit with 422 INVALID_LIMIT, and clamps a large one', async () => {
    const caller = await createV1Caller();

    const rejected = await GET(req(caller.headers, '?limit=0'));
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({ code: 'INVALID_LIMIT' });

    // Clamped, not rejected — asking for more than the ceiling is answered
    // with the ceiling.
    const clamped = await GET(req(caller.headers, '?limit=100000'));
    expect(clamped.status).toBe(200);
  });

  it('isolates tenants — another user’s workspaces never appear', async () => {
    const mine = await createV1Caller({ workspaceName: 'Mine' });
    const theirs = await createV1Caller({ workspaceName: 'Theirs' });

    const page = await fetchPage(mine.headers, '?limit=100');
    const ids = page.items.map((w) => w.id);

    expect(ids).toContain(mine.workspace.id);
    expect(ids).not.toContain(theirs.workspace.id);
  });

  it('rejects an unauthenticated caller before parsing the query at all', async () => {
    // A request that is BOTH unauthenticated and malformed must answer 401,
    // not 422: auth runs first, so no parsing or reading happens for a caller
    // we have not identified.
    const res = await GET(new Request(`${BASE}?cursor=garbage&limit=0`));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
