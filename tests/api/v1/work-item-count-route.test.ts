import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemCountSchema } from '@/lib/api/v1/workItems/schema';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/projects/{projectKey}/work-items/count (Story 11.5 · Subtask
// 11.5.16 — MOTIR-2318), the operation ADR Amendment 11 decided on.
//
// The endpoint's entire promise is that it counts what the COLLECTION would
// page. So the assertions here are mostly not about a number in isolation —
// they drive both endpoints over the same data with the same filter and compare
// them. A count that agrees with a hand-written expectation but disagrees with
// its own collection is the failure this endpoint exists to avoid, and it is
// invisible to a test that only checks the number.

async function count(
  projectKey: string,
  caller: { headers: Record<string, string> },
  query = '',
): Promise<Response> {
  const { GET } = await import('@/app/api/v1/projects/[projectKey]/work-items/count/route');
  const url = `http://localhost:3000/api/v1/projects/${encodeURIComponent(projectKey)}/work-items/count${query}`;
  return GET(new Request(url, { headers: caller.headers }), {
    params: Promise.resolve({ projectKey }),
  });
}

/** Walk the COLLECTION to exhaustion and return every key it pages. */
async function collectionKeys(
  projectKey: string,
  caller: { headers: Record<string, string> },
  filterQuery = '',
): Promise<string[]> {
  const { GET } = await import('@/app/api/v1/projects/[projectKey]/work-items/route');
  const keys: string[] = [];
  let cursor: string | null = null;
  do {
    const query = `?limit=2${filterQuery}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const url = `http://localhost:3000/api/v1/projects/${encodeURIComponent(projectKey)}/work-items${query}`;
    const res: Response = await GET(new Request(url, { headers: caller.headers }), {
      params: Promise.resolve({ projectKey }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { key: string }[]; nextCursor: string | null };
    keys.push(...body.items.map((i) => i.key));
    cursor = body.nextCursor;
  } while (cursor);
  return keys;
}

const BUGS_ONLY: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
};

function filterQuery(ast: FilterAst): string {
  return `&filter=${encodeURIComponent(encodeFilterParam(ast))}`;
}

describe('GET /api/v1/projects/{projectKey}/work-items/count', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller();
  });

  it('answers the count in ONE request, in the declared shape', async () => {
    for (let i = 0; i < 5; i++) {
      await createTestWorkItem(caller.fixture, { kind: 'task', title: `Item ${i}` });
    }

    const res = await count(caller.projectKey, caller);

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    // Parsed by the SAME schema the document publishes, so a field renamed here
    // fails rather than quietly changing what the operation returns.
    expect(workItemCountSchema.parse(body)).toEqual({ count: 5 });
  });

  // ── The promise: the count and the collection agree ───────────────────────
  it('counts exactly what the COLLECTION pages, unfiltered', async () => {
    for (let i = 0; i < 5; i++) {
      await createTestWorkItem(caller.fixture, { kind: 'task', title: `Item ${i}` });
    }

    const keys = await collectionKeys(caller.projectKey, caller);
    const body = (await (await count(caller.projectKey, caller)).json()) as { count: number };

    // Walked over three pages of two; the count is one request for the same set.
    expect(keys).toHaveLength(5);
    expect(body.count).toBe(keys.length);
  });

  it('counts exactly what the COLLECTION pages, under a filter', async () => {
    await createTestWorkItem(caller.fixture, { kind: 'bug', title: 'A defect' });
    await createTestWorkItem(caller.fixture, { kind: 'bug', title: 'Another defect' });
    await createTestWorkItem(caller.fixture, { kind: 'task', title: 'A task' });
    await createTestWorkItem(caller.fixture, { kind: 'story', title: 'A story' });

    const query = filterQuery(BUGS_ONLY);
    const keys = await collectionKeys(caller.projectKey, caller, query);
    const res = await count(caller.projectKey, caller, `?${query.slice(1)}`);
    const body = (await res.json()) as { count: number };

    expect(keys).toHaveLength(2);
    expect(body.count).toBe(keys.length);
  });

  it('a filter matching nothing is a count of ZERO, not an error', async () => {
    for (let i = 0; i < 3; i++) {
      await createTestWorkItem(caller.fixture, { kind: 'task', title: `Item ${i}` });
    }
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'status', operator: 'is_any_of', value: ['nonexistent_status'] }],
    };

    const res = await count(
      caller.projectKey,
      caller,
      `?filter=${encodeURIComponent(encodeFilterParam(ast))}`,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 0 });
  });

  it('an empty project counts ZERO', async () => {
    const res = await count(caller.projectKey, caller);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 0 });
  });

  // ── The shared decode ─────────────────────────────────────────────────────
  //
  // `parseFilterParam` moved out of the collection route so both could use it.
  // These pin that the count reports a bad filter with the SAME codes — the
  // reason the decode is shared rather than copied.
  it('reports an undecodable filter as INVALID_FILTER, like the collection', async () => {
    const res = await count(caller.projectKey, caller, '?filter=not-a-filter');

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_FILTER');
  });

  it('404s an unknown project rather than counting zero', async () => {
    // Zero would be a truthful-looking answer to a question that was never
    // valid, and a client would read it as "this project is empty".
    const res = await count('NOSUCH', caller);
    expect(res.status).toBe(404);
  });

  // ── No paging surface ─────────────────────────────────────────────────────
  it('ignores `limit` and `cursor` rather than counting a window', async () => {
    for (let i = 0; i < 5; i++) {
      await createTestWorkItem(caller.fixture, { kind: 'task', title: `Item ${i}` });
    }

    // A count has no page size. Sending one must not narrow the answer — that
    // is the confusion a `?limit=0` spelling would have institutionalised.
    const res = await count(caller.projectKey, caller, '?limit=2');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 5 });
  });
});
