import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemSummarySchema } from '@/lib/api/v1/workItems/schema';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, encodePageCursor } from '@/lib/api/v1/pagination';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { DEFAULT_SORT, ISSUE_LIST_PAGE_SIZE } from '@/lib/issues/issueListView';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestWorkItem } from '../../fixtures';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// GET /api/v1/projects/{projectKey}/work-items (Story 11.2 · Subtask 11.2.4 —
// MOTIR-2042). The flagship read: FilterAST-narrowed, keyset-cursor-paged.

interface Envelope {
  items: Array<{ key: string }>;
  nextCursor: string | null;
}

async function get(
  projectKey: string,
  caller: { headers: Record<string, string> },
  query = '',
): Promise<Response> {
  const { GET } = await import('@/app/api/v1/projects/[projectKey]/work-items/route');
  const url = `http://localhost:3000/api/v1/projects/${encodeURIComponent(projectKey)}/work-items${query}`;
  return GET(new Request(url, { headers: caller.headers }), {
    params: Promise.resolve({ projectKey }),
  });
}

describe('GET /api/v1/projects/{projectKey}/work-items', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller();
  });

  async function seed(count: number): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < count; i++) {
      const row = await createTestWorkItem(caller.fixture, { kind: 'task', title: `Item ${i}` });
      keys.push(row.identifier);
    }
    return keys;
  }

  /** Walk the endpoint to exhaustion, returning every key and the request count. */
  async function walk(query = '', limit = 3): Promise<{ keys: string[]; requests: number }> {
    const keys: string[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const q = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${query}`;
      const res = await get(caller.projectKey, caller, q);
      expect(res.status, 'every page of a walk answers 200').toBe(200);
      const page = (await res.json()) as Envelope;
      keys.push(...page.items.map((i) => i.key));
      cursor = page.nextCursor;
      requests += 1;
    } while (cursor && requests < 100);
    return { keys, requests };
  }

  it('returns the list envelope, and every row PARSES against the summary schema', async () => {
    await seed(3);

    const res = await get(caller.projectKey, caller);
    const body = (await res.json()) as Envelope;

    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(3);
    for (const row of body.items) {
      const parsed = workItemSummarySchema.safeParse(row);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it('an EMPTY result is 200 with items: [] and nextCursor: null — never a 404', async () => {
    const res = await get(caller.projectKey, caller);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('pages a collection larger than one page, yielding every row EXACTLY once', async () => {
    const seeded = await seed(11);

    const { keys } = await walk('', 4);

    expect(keys).toHaveLength(11);
    expect(new Set(keys).size).toBe(11);
    expect([...keys].sort()).toEqual([...seeded].sort());
  });

  it('the LAST page carries nextCursor: null (no extra empty round trip)', async () => {
    await seed(4);

    const res = await get(caller.projectKey, caller, '?limit=4');
    const body = (await res.json()) as Envelope;

    expect(body.items).toHaveLength(4);
    expect(body.nextCursor).toBeNull();
  });

  // ── The one-grammar contract, end to end ──────────────────────────────────
  it('returns the SAME key set as the /items view for an IDENTICAL FilterAST', async () => {
    const bug = await createTestWorkItem(caller.fixture, { kind: 'bug', title: 'A defect' });
    await createTestWorkItem(caller.fixture, { kind: 'task', title: 'A task' });
    await createTestWorkItem(caller.fixture, { kind: 'story', title: 'A story' });

    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };

    // Through the API, walked to exhaustion…
    const viaApi = await walk(`&filter=${encodeURIComponent(encodeFilterParam(ast))}`, 1);

    // …and through the web app's OWN read, with the same AST.
    const viaList = await workItemsService.getProjectIssuesList(
      caller.fixture.projectId,
      { sort: DEFAULT_SORT, filter: { ast }, page: 1, pageSize: ISSUE_LIST_PAGE_SIZE },
      caller.ctx,
    );

    expect(viaApi.keys).toEqual([bug.identifier]);
    expect([...viaApi.keys].sort()).toEqual(viaList.items.map((i) => i.identifier).sort());
  });

  it('a filter matching nothing is an empty page, not an error', async () => {
    await seed(3);
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'status', operator: 'is_any_of', value: ['nonexistent_status'] }],
    };

    const res = await get(
      caller.projectKey,
      caller,
      `?filter=${encodeURIComponent(encodeFilterParam(ast))}`,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [], nextCursor: null });
  });

  // ── No unbounded read ─────────────────────────────────────────────────────
  it('never reads more than limit + 1 rows for a page, however large the project', async () => {
    await seed(30);
    const spy = vi.spyOn(workItemsService, 'listProjectWorkItemsPage');

    try {
      const res = await get(caller.projectKey, caller, '?limit=5');
      const body = (await res.json()) as Envelope;

      // The service is called WITH a bound — the route never asks for
      // "everything" and slices afterwards (which is what `paginateKeyset`
      // would have done, and why 11.2.3 exists).
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toMatchObject({ limit: 5 });
      expect(body.items).toHaveLength(5);
      expect(body.nextCursor).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('honours limit=100 (NOT capped at the List view 50) and clamps above the ceiling', async () => {
    await seed(60);

    const hundred = (await (await get(caller.projectKey, caller, '?limit=100')).json()) as Envelope;
    expect(hundred.items.length, 'must not be clamped to 50').toBe(60);
    expect(ISSUE_LIST_PAGE_SIZE).toBe(50);

    // Above the ceiling CLAMPS rather than erroring — asking for more than the
    // maximum is a reasonable request answered with the maximum.
    const over = await get(caller.projectKey, caller, `?limit=${MAX_PAGE_LIMIT + 1000}`);
    expect(over.status).toBe(200);
    expect(((await over.json()) as Envelope).items).toHaveLength(60);
  });

  it('defaults to the documented page size when `limit` is omitted', async () => {
    await seed(55);

    const body = (await (await get(caller.projectKey, caller)).json()) as Envelope;

    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(body.items).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(body.nextCursor).not.toBeNull();
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '2.5'],
    ['non-numeric', 'ten'],
  ])('422s a %s limit rather than coercing it', async (_label, value) => {
    const res = await get(caller.projectKey, caller, `?limit=${value}`);

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_LIMIT' });
  });

  it.each([
    ['malformed', 'not-a-cursor'],
    ['truncated', encodePageCursor({ createdAt: new Date().toISOString(), id: 'x' }).slice(0, 10)],
    ['tampered', `${encodePageCursor({ createdAt: new Date().toISOString(), id: 'x' })}zz`],
  ])('422s a %s cursor — never a silent reset to page one', async (_label, cursor) => {
    await seed(3);

    const res = await get(caller.projectKey, caller, `?cursor=${encodeURIComponent(cursor)}`);

    // A silent reset is the failure mode that makes a client loop forever over
    // the first page, so the refusal is the feature.
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  // ── The filter's own failure modes, each with its own code ────────────────
  it('422s a structurally malformed ?filter=', async () => {
    const res = await get(caller.projectKey, caller, '?filter=garbage');

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'INVALID_FILTER' });
  });

  it('422s a filter written for an UNSUPPORTED version, distinctly', async () => {
    const res = await get(caller.projectKey, caller, '?filter=v9%3Aabc');

    expect(res.status).toBe(422);
    // Distinct from INVALID_FILTER: this one tells a client to upgrade rather
    // than to re-encode.
    await expect(res.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_FILTER_VERSION' });
  });

  it.each([
    [
      'UNKNOWN_FILTER_FIELD',
      { combinator: 'and', conditions: [{ field: 'nope', operator: 'is_any_of', value: ['x'] }] },
    ],
    [
      'UNKNOWN_FILTER_OPERATOR',
      { combinator: 'and', conditions: [{ field: 'kind', operator: 'contains', value: 'x' }] },
    ],
    [
      'INVALID_FILTER_VALUE',
      {
        combinator: 'and',
        conditions: [{ field: 'kind', operator: 'is_any_of', value: 'not-a-list' }],
      },
    ],
  ])('422s with code %s when the AST fails registry validation', async (code, ast) => {
    const res = await get(
      caller.projectKey,
      caller,
      `?filter=${encodeURIComponent(encodeFilterParam(ast as FilterAst))}`,
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code });
  });

  it('422s an over-cap filter with FILTER_TOO_LARGE', async () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: Array.from({ length: 25 }, () => ({
        field: 'kind' as const,
        operator: 'is_any_of' as const,
        value: ['task'],
      })),
    };

    const res = await get(
      caller.projectKey,
      caller,
      `?filter=${encodeURIComponent(encodeFilterParam(ast))}`,
    );

    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({ code: 'FILTER_TOO_LARGE' });
  });

  // ── Isolation + auth ──────────────────────────────────────────────────────
  it('404s an unknown project key and a project in another workspace, identically', async () => {
    const other = await createV1ProjectCaller({ workspaceName: 'Theirs', identifier: 'OTHR' });
    await createTestWorkItem(other.fixture, { kind: 'task', title: 'Not yours' });

    const unknown = await get('NOSUCH', caller);
    const foreign = await get(other.projectKey, caller);

    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);

    const unknownBody = (await unknown.json()) as { code: string; error: string };
    const foreignBody = (await foreign.json()) as { code: string; error: string };

    // The machine contract is IDENTICAL — a client branches on `code`, and the
    // two causes are indistinguishable there. The human sentence echoes the key
    // the CALLER supplied, which discloses nothing they did not already know;
    // what matters is that it reveals nothing ABOUT the foreign project.
    expect(unknownBody.code).toBe('PROJECT_NOT_FOUND');
    expect(foreignBody.code).toBe(unknownBody.code);
    expect(foreignBody.error).not.toContain(other.workspace.id);
    expect(foreignBody.error).not.toContain(other.fixture.projectId);
    expect(foreignBody.error).not.toMatch(/exist|forbidden|permission|another/i);
  });

  it('401s without a credential and 403s a token lacking `read`', async () => {
    const { GET } = await import('@/app/api/v1/projects/[projectKey]/work-items/route');
    const anonymous = await GET(
      new Request(`http://localhost:3000/api/v1/projects/${caller.projectKey}/work-items`),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(anonymous.status).toBe(401);

    const wrongScope = await createV1ProjectCaller({ scopes: ['integration'] });
    const scoped = await get(wrongScope.projectKey, wrongScope);
    expect(scoped.status).toBe(403);
  });

  it('parses the request BEFORE reading — a bad limit costs no service call', async () => {
    const spy = vi.spyOn(workItemsService, 'listProjectWorkItemsPage');
    try {
      expect((await get(caller.projectKey, caller, '?limit=0')).status).toBe(422);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
