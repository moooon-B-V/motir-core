import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { startMcpHttpServer, type McpTestServer } from '../../helpers/mcpHttpServer';
import {
  createV1ProjectCaller,
  withTokenFor,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import { v1RouteFiles } from '../../helpers/v1RouteAudit';
import { truncateAuthTables } from '../../helpers/db';

// END-TO-END CONFORMANCE for the WORK-ITEM resource (Story 11.2 · Subtask
// 11.2.12 — MOTIR-2054), written from the INTEGRATOR's seat rather than the
// codebase's: a real PAT, real HTTP over a real socket, the real route
// handlers, real Postgres. No service imports, no in-process shortcuts.
//
// ⚠️ EVERY assertion reads the WIRE — status, headers, JSON. A conformance suite
// that imports a service is testing the codebase, not the contract. That is the
// rule this file is built around, and it is why nothing below reaches for a
// repository to "just check" a row: if the API cannot show it, it is not shown.
//
// This is also the Story's E2E in the form the Story actually has. There is no
// user-observable surface — no page, no panel, nothing a person watches — so it
// is exempt from the acceptance-video rule under its non-UI carve-out and
// accepts on its tests alone, exactly as Story 11.1 did. A Playwright browser
// test would be theatre: the client is `curl`, so the test is an HTTP client.

let server: McpTestServer;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});
afterAll(async () => {
  await server.close();
});

const savedEnv = {
  limit: process.env['MOTIR_API_V1_RATE_LIMIT'],
  window: process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'],
};
afterEach(() => {
  if (savedEnv.limit === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT'];
  else process.env['MOTIR_API_V1_RATE_LIMIT'] = savedEnv.limit;
  if (savedEnv.window === undefined) delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];
  else process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = savedEnv.window;
});

interface Caller {
  headers: Record<string, string>;
}

/** One HTTP call, exactly as an external client makes it. */
async function http(
  path: string,
  caller: Caller | null,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(caller?.headers ?? {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('/api/v1 work-item conformance — an external client with a real PAT', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'work_items:archive'],
    });
  });

  // ⚠️ THE JOURNEY, in one pass, as ONE client. Each step consumes ONLY what the
  // previous step returned — the created key, the nextCursor, the ETag — so a
  // break anywhere in the chain fails the test rather than being papered over by
  // a fixture that knew the answer already.
  it('drives the whole journey: list → filter → page → read → create → patch → move → comment → link → archive → restore', async () => {
    const project = `/api/v1/projects/${caller.projectKey}/work-items`;

    // 1. LIST an empty project — 200 with an empty page, never a 404.
    const empty = await http(`${project}?limit=5`, caller);
    expect(empty.status).toBe(200);
    expect(await json(empty)).toEqual({ items: [], nextCursor: null });

    // 2. CREATE — 201, with a Location a client can follow.
    const created = await http(project, caller, {
      method: 'POST',
      body: { kind: 'task', title: 'Integrate with Motir', type: 'code', priority: 'high' },
    });
    expect(created.status).toBe(201);
    const item = await json<{ key: string; title: string }>(created);
    const location = created.headers.get('location');
    expect(location).toBe(`/api/v1/work-items/${item.key}`);

    // …seed a few more so paging has something to do.
    for (let i = 0; i < 4; i++) {
      const extra = await http(project, caller, {
        method: 'POST',
        body: { kind: 'bug', title: `Defect ${i}` },
      });
      expect(extra.status).toBe(201);
    }

    // 3. FOLLOW the Location header — only what step 2 returned.
    const followed = await http(location as string, caller);
    expect(followed.status).toBe(200);
    const detail = await json<{ key: string; title: string; status: string }>(followed);
    expect(detail.key).toBe(item.key);
    expect(detail.title).toBe('Integrate with Motir');

    // 4. FILTER — the same grammar the web app uses.
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };
    const filtered = await http(
      `${project}?limit=100&filter=${encodeURIComponent(encodeFilterParam(ast))}`,
      caller,
    );
    expect(filtered.status).toBe(200);
    expect((await json<{ items: unknown[] }>(filtered)).items).toHaveLength(4);

    // 5. PAGE to the end, following ONLY the cursors the API hands back.
    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const page = await http(
        `${project}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        caller,
      );
      expect(page.status).toBe(200);
      const body = await json<{ items: Array<{ key: string }>; nextCursor: string | null }>(page);
      seen.push(...body.items.map((i) => i.key));
      cursor = body.nextCursor;
      requests += 1;
    } while (cursor && requests < 50);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size, 'every row exactly once').toBe(5);

    // 6. PATCH with the ETag the READ issued — nothing else.
    const etag = followed.headers.get('etag');
    expect(etag).toBeTruthy();
    const patched = await http(`/api/v1/work-items/${item.key}`, caller, {
      method: 'PATCH',
      headers: { 'if-match': etag as string },
      body: { title: 'Integrate with Motir, properly' },
    });
    expect(patched.status).toBe(200);
    expect((await json<{ title: string }>(patched)).title).toBe('Integrate with Motir, properly');

    // 7. TRANSITIONS — ask, then move to a target the API itself advertised.
    const legal = await http(`/api/v1/work-items/${item.key}/transitions`, caller);
    expect(legal.status).toBe(200);
    const targets = (await json<{ transitions: Array<{ key: string }> }>(legal)).transitions;
    expect(targets.length).toBeGreaterThan(0);
    const moved = await http(`/api/v1/work-items/${item.key}/transitions`, caller, {
      method: 'POST',
      body: { status: targets[0]?.key },
    });
    expect(moved.status).toBe(200);
    expect((await json<{ status: string }>(moved)).status).toBe(targets[0]?.key);

    // 8. COMMENT, then read it back.
    const comment = await http(`/api/v1/work-items/${item.key}/comments`, caller, {
      method: 'POST',
      body: { bodyMd: 'Shipping this today.' },
    });
    expect(comment.status).toBe(201);
    const commentId = (await json<{ id: string }>(comment)).id;
    const thread = await http(`/api/v1/work-items/${item.key}/comments`, caller);
    expect((await json<{ items: Array<{ id: string }> }>(thread)).items[0]?.id).toBe(commentId);

    // 9. LINK a dependency — the edge that makes the data a plan.
    const blockerKey = seen.find((k) => k !== item.key) as string;
    const linked = await http(`/api/v1/work-items/${item.key}/links`, caller, {
      method: 'POST',
      body: { toKey: blockerKey, relationship: 'blocked_by' },
    });
    expect(linked.status).toBe(201);
    const edges = await http(`/api/v1/work-items/${item.key}/links`, caller);
    expect(
      (await json<{ blockedBy: Array<{ key: string }> }>(edges)).blockedBy.map((r) => r.key),
    ).toEqual([blockerKey]);

    // 10. ARCHIVE, and watch it leave the collection.
    expect(
      (await http(`/api/v1/work-items/${item.key}/archive`, caller, { method: 'POST' })).status,
    ).toBe(200);
    const afterArchive = await http(`${project}?limit=100`, caller);
    expect(
      (await json<{ items: Array<{ key: string }> }>(afterArchive)).items.map((i) => i.key),
    ).not.toContain(item.key);

    // 11. RESTORE, and watch it come back.
    expect(
      (await http(`/api/v1/work-items/${item.key}/restore`, caller, { method: 'POST' })).status,
    ).toBe(200);
    const afterRestore = await http(`${project}?limit=100`, caller);
    expect(
      (await json<{ items: Array<{ key: string }> }>(afterRestore)).items.map((i) => i.key),
    ).toContain(item.key);
  });

  // ── The scope matrix, as an integrator would actually mint tokens ─────────
  it('a READ-ONLY token walks every GET and is refused 403 on every mutation', async () => {
    // One tenant, several tokens — exactly how an integrator mints them: the
    // capability under test must be the SCOPE, not the workspace, so every token
    // below belongs to the same owner and the same workspace.
    const writer = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const key = (
      await json<{ key: string }>(
        await http(`/api/v1/projects/${writer.projectKey}/work-items`, writer, {
          method: 'POST',
          body: { kind: 'task', title: 'Guarded' },
        }),
      )
    ).key;

    // Every GET on the writer's own token answers…
    for (const path of [
      `/api/v1/projects/${writer.projectKey}/work-items`,
      `/api/v1/work-items/${key}`,
      `/api/v1/work-items/${key}/transitions`,
      `/api/v1/work-items/${key}/comments`,
      `/api/v1/work-items/${key}/links`,
    ]) {
      expect((await http(path, writer)).status, `GET ${path}`).toBe(200);
    }

    // …and every MUTATION on a read-only token is 403, not 200-with-nothing.
    const readOnlyOnSameTenant = await withTokenFor(
      writer.fixture.owner,
      writer.fixture.workspace,
      { scopes: ['read'] },
    );

    const mutations: Array<[string, { method: string; body?: unknown }]> = [
      [
        `/api/v1/projects/${writer.projectKey}/work-items`,
        { method: 'POST', body: { kind: 'task', title: 'no' } },
      ],
      [`/api/v1/work-items/${key}`, { method: 'PATCH', body: { title: 'no' } }],
      [
        `/api/v1/work-items/${key}/transitions`,
        { method: 'POST', body: { status: 'in_progress' } },
      ],
      [`/api/v1/work-items/${key}/comments`, { method: 'POST', body: { bodyMd: 'no' } }],
      [
        `/api/v1/work-items/${key}/links`,
        { method: 'POST', body: { toKey: key, relationship: 'relates_to' } },
      ],
      [`/api/v1/work-items/${key}/archive`, { method: 'POST' }],
      [`/api/v1/work-items/${key}/restore`, { method: 'POST' }],
    ];
    for (const [path, init] of mutations) {
      const res = await http(path, readOnlyOnSameTenant, init);
      expect(res.status, `${init.method} ${path} on a read-only token`).toBe(403);
      expect((await json<{ code: string }>(res)).code).toBe('INSUFFICIENT_SCOPE');
    }

    // A WRITE token is still refused on archive — the scope split, over the wire.
    expect(
      (await http(`/api/v1/work-items/${key}/archive`, writer, { method: 'POST' })).status,
    ).toBe(403);

    // …and an ARCHIVE token succeeds.
    const archiver = await withTokenFor(writer.fixture.owner, writer.fixture.workspace, {
      scopes: ['read', 'work_items:archive'],
    });
    expect(
      (await http(`/api/v1/work-items/${key}/archive`, archiver, { method: 'POST' })).status,
    ).toBe(200);
  });

  // ── Cross-tenant: ENUMERATED, not sampled ────────────────────────────────
  it('404s cross-tenant on EVERY endpoint that takes a key or project key', async () => {
    const theirs = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'work_items:archive'],
      workspaceName: 'Theirs',
      identifier: 'OTHR',
    });
    const theirKey = (
      await json<{ key: string }>(
        await http(`/api/v1/projects/${theirs.projectKey}/work-items`, theirs, {
          method: 'POST',
          body: { kind: 'task', title: 'Theirs' },
        }),
      )
    ).key;

    // One endpoint answering 403 instead of 404 is the leak, so the whole
    // surface is listed rather than a sample of it.
    const probes: Array<[string, { method: string; body?: unknown }]> = [
      [`/api/v1/projects/${theirs.projectKey}/work-items`, { method: 'GET' }],
      [
        `/api/v1/projects/${theirs.projectKey}/work-items`,
        { method: 'POST', body: { kind: 'task', title: 'x' } },
      ],
      [`/api/v1/work-items/${theirKey}`, { method: 'GET' }],
      [`/api/v1/work-items/${theirKey}`, { method: 'PATCH', body: { title: 'x' } }],
      [`/api/v1/work-items/${theirKey}/transitions`, { method: 'GET' }],
      [
        `/api/v1/work-items/${theirKey}/transitions`,
        { method: 'POST', body: { status: 'in_progress' } },
      ],
      [`/api/v1/work-items/${theirKey}/comments`, { method: 'GET' }],
      [`/api/v1/work-items/${theirKey}/comments`, { method: 'POST', body: { bodyMd: 'x' } }],
      [`/api/v1/work-items/${theirKey}/links`, { method: 'GET' }],
      [`/api/v1/work-items/${theirKey}/archive`, { method: 'POST' }],
      [`/api/v1/work-items/${theirKey}/restore`, { method: 'POST' }],
    ];

    for (const [path, init] of probes) {
      const res = await http(path, caller, init);
      expect(res.status, `${init.method} ${path} must be 404, never 403`).toBe(404);
      const body = await json<{ code: string }>(res);
      expect(body.code).toBeTruthy();
    }
  });

  // ── Envelope, on the wire ────────────────────────────────────────────────
  it('every response carries the request id and the rate-limit headers, success AND failure', async () => {
    const created = await http(`/api/v1/projects/${caller.projectKey}/work-items`, caller, {
      method: 'POST',
      body: { kind: 'task', title: 'Headers' },
    });
    const key = (await json<{ key: string }>(created)).key;

    for (const res of [
      created,
      await http(`/api/v1/work-items/${key}`, caller),
      await http(`/api/v1/work-items/NOPE-1`, caller),
      await http(`/api/v1/projects/${caller.projectKey}/work-items?limit=0`, caller),
    ]) {
      expect(res.headers.get('x-request-id'), 'a request id on every response').toBeTruthy();
      expect(res.headers.get('x-ratelimit-limit')).toBeTruthy();
      expect(res.headers.get('x-ratelimit-remaining')).toBeTruthy();
      expect(res.headers.get('x-ratelimit-reset')).toBeTruthy();
    }
  });

  it('a full paged scan of a realistic collection never trips the limiter', async () => {
    // The SHIPPED budget, not a widened one — the assertion is about the real
    // configuration. Two features individually correct and jointly useless is
    // the failure this catches.
    delete process.env['MOTIR_API_V1_RATE_LIMIT'];
    delete process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'];
    resetRateLimitStore();

    const project = `/api/v1/projects/${caller.projectKey}/work-items`;
    for (let i = 0; i < 20; i++) {
      await http(project, caller, { method: 'POST', body: { kind: 'task', title: `T${i}` } });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const res = await http(
        `${project}?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        caller,
      );
      expect(res.status, 'a full scan must never be rate-limited').toBe(200);
      const body = await json<{ items: Array<{ key: string }>; nextCursor: string | null }>(res);
      seen.push(...body.items.map((i) => i.key));
      cursor = body.nextCursor;
      requests += 1;
    } while (cursor && requests < 20);

    expect(seen).toHaveLength(20);
  });

  it('the cursor stays HONEST across a collection being written mid-scan', async () => {
    const project = `/api/v1/projects/${caller.projectKey}/work-items`;
    const original: string[] = [];
    for (let i = 0; i < 6; i++) {
      original.push(
        (
          await json<{ key: string }>(
            await http(project, caller, { method: 'POST', body: { kind: 'task', title: `R${i}` } }),
          )
        ).key,
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let page = 0;
    do {
      const res = await http(
        `${project}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        caller,
      );
      const body = await json<{ items: Array<{ key: string }>; nextCursor: string | null }>(res);
      seen.push(...body.items.map((i) => i.key));
      cursor = body.nextCursor;
      if (page === 0) {
        // Insert mid-scan — the case that makes an offset pager skip a row.
        await http(project, caller, { method: 'POST', body: { kind: 'task', title: 'Injected' } });
      }
      page += 1;
    } while (cursor && page < 20);

    for (const key of original) {
      expect(
        seen.filter((k) => k === key),
        `${key} seen exactly once`,
      ).toHaveLength(1);
    }
  });

  // ── The unhappy paths a real client hits FIRST ───────────────────────────
  it('answers the five first-contact failures with their documented status and code', async () => {
    const project = `/api/v1/projects/${caller.projectKey}/work-items`;
    const key = (
      await json<{ key: string }>(
        await http(project, caller, { method: 'POST', body: { kind: 'task', title: 'Unhappy' } }),
      )
    ).key;
    const other = (
      await json<{ key: string }>(
        await http(project, caller, { method: 'POST', body: { kind: 'task', title: 'Other' } }),
      )
    ).key;

    // 1. A bad token — 401, undifferentiated.
    const badToken = await http(`/api/v1/work-items/${key}`, {
      headers: { authorization: 'Bearer motir_pat_not_a_real_token' },
    });
    expect(badToken.status).toBe(401);
    expect((await json<{ code: string }>(badToken)).code).toBe('UNAUTHENTICATED');

    // 2. A malformed cursor — 422, never a silent reset to page one.
    const badCursor = await http(`${project}?cursor=nonsense`, caller);
    expect(badCursor.status).toBe(422);
    expect((await json<{ code: string }>(badCursor)).code).toBe('INVALID_CURSOR');

    // 3. An illegal transition — 422 + the allowed targets AS DATA.
    const illegal = await http(`/api/v1/work-items/${key}/transitions`, caller, {
      method: 'POST',
      body: { status: 'done' },
    });
    expect(illegal.status).toBe(422);
    const refusal = await json<{ code: string; allowedTransitions: Array<{ key: string }> }>(
      illegal,
    );
    expect(refusal.code).toBe('ILLEGAL_TRANSITION');
    expect(Array.isArray(refusal.allowedTransitions)).toBe(true);
    expect(refusal.allowedTransitions.length).toBeGreaterThan(0);

    // 4. A duplicate link — 409.
    const linkBody = { toKey: other, relationship: 'relates_to' };
    expect(
      (await http(`/api/v1/work-items/${key}/links`, caller, { method: 'POST', body: linkBody }))
        .status,
    ).toBe(201);
    const duplicate = await http(`/api/v1/work-items/${key}/links`, caller, {
      method: 'POST',
      body: linkBody,
    });
    expect(duplicate.status).toBe(409);
    expect((await json<{ code: string }>(duplicate)).code).toBe('DUPLICATE_LINK');

    // 5. A stale If-Match — 412.
    const read = await http(`/api/v1/work-items/${key}`, caller);
    const stale = read.headers.get('etag') as string;
    await http(`/api/v1/work-items/${key}`, caller, { method: 'PATCH', body: { title: 'Moved' } });
    const conflict = await http(`/api/v1/work-items/${key}`, caller, {
      method: 'PATCH',
      headers: { 'if-match': stale },
      body: { title: 'Mine' },
    });
    expect(conflict.status).toBe(412);
    expect((await json<{ code: string }>(conflict)).code).toBe('STALE_WORK_ITEM');
  });

  it('never answers 500, and every failure body is { code, error }', async () => {
    const project = `/api/v1/projects/${caller.projectKey}/work-items`;
    const probes = [
      `${project}?limit=-1`,
      `${project}?filter=garbage`,
      `${project}?cursor=zzz`,
      '/api/v1/work-items/not-a-key',
      '/api/v1/work-items/NOPE-1',
      '/api/v1/work-items/NOPE-1/links',
    ];

    for (const path of probes) {
      const res = await http(path, caller);
      expect(res.status, `${path} must not 500`).not.toBe(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await json<{ code?: string; error?: string }>(res);
      expect(typeof body.code, `${path} carries a stable code`).toBe('string');
      expect(typeof body.error, `${path} carries a human sentence`).toBe('string');
      // No stack, no driver text, no host:port.
      expect(JSON.stringify(body)).not.toMatch(/at \w+ \(|5432|prisma/i);
    }
  });

  // ⚠️ A conformance suite that silently misses an endpoint proves nothing.
  it('fails loudly if an endpoint is added to this story without a conformance step', () => {
    const covered = [
      'app/api/v1/projects/[projectKey]/work-items/route.ts',
      'app/api/v1/work-items/[key]/route.ts',
      'app/api/v1/work-items/[key]/transitions/route.ts',
      'app/api/v1/work-items/[key]/comments/route.ts',
      'app/api/v1/work-items/[key]/links/route.ts',
      'app/api/v1/work-items/[key]/archive/route.ts',
      'app/api/v1/work-items/[key]/restore/route.ts',
    ];
    // ⚠️ 11.2's OWN work-item endpoints, not every path that ends in
    // `work-items`. Story 11.3 adds two membership moves —
    // `sprints/{id}/work-items` and `projects/{key}/backlog/work-items` — which
    // are SPRINT operations wearing a work-item noun: they carry `sprints:write`
    // and their journey is 11.3's conformance suite, not this one. Filtering
    // them out here keeps this guard honest about what IT covers rather than
    // making it fail for another story's endpoints.
    //
    // ⚠️ Story 11.7's WORK-LOOP sub-resources are excluded for exactly the same
    // reason: `…/dispatch-prompt`, `…/integration`, `…/expansions` and
    // `…/activity` hang off a work item because that is what they are ABOUT, but
    // they are work-loop operations and their journey is 11.7's own conformance
    // suite (MOTIR-2243). Listing them here would make this guard pass by
    // covering them in the wrong story's walk.
    const WORK_LOOP_SUBRESOURCES = /\/(dispatch-prompt|integration|expansions|activity)\//;
    const shipped = v1RouteFiles(process.cwd()).filter(
      (f) =>
        f.includes('work-items') &&
        !/\/(sprints|backlog)\//.test(f) &&
        !WORK_LOOP_SUBRESOURCES.test(f),
    );

    // Enumerated rather than counted: a NEW work-item endpoint appears here as a
    // failure naming the file, which is the prompt to add its journey step.
    expect([...shipped].sort()).toEqual([...covered].sort());
  });
});
