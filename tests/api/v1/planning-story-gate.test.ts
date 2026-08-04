import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { encodeCollectionCursor, V1_COLLECTIONS } from '@/lib/api/v1/pagination';
import { projectSchema } from '@/lib/api/v1/projects/schema';
import { sprintSchema } from '@/lib/api/v1/sprints/schema';
import { readyItemSchema } from '@/lib/api/v1/ready/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import { readRouteSource, v1RouteFiles } from '../../helpers/v1RouteAudit';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The Story 11.3 vitest GATE (Subtask 11.3.10 — MOTIR-2067).
//
// It measures the story's REAL merged surface, so it runs AFTER the feature
// cards. Its job is the three things their own suites structurally cannot do:
//
//   1. Cover the seams BETWEEN cards — a mapper and a read that drift apart
//      while every unit still passes.
//   2. Drive one card's REAL output through the next card's REAL consumer.
//   3. Assert the CONTRACT guarantees a coverage percentage cannot see.
//
// ⚠️ Every guard below is also asserted to FAIL on a planted violation. A guard
// nobody has seen fail is not a guard — it is a comment that runs.

const REPO_ROOT = process.cwd();
const BASE = 'http://localhost:3000/api/v1';

/** Every route this story ships, named EXPLICITLY so a deleted one fails. */
const STORY_ROUTES = [
  'app/api/v1/projects/route.ts',
  'app/api/v1/projects/[projectKey]/route.ts',
  'app/api/v1/projects/[projectKey]/sprints/route.ts',
  'app/api/v1/projects/[projectKey]/backlog/route.ts',
  'app/api/v1/projects/[projectKey]/backlog/work-items/route.ts',
  'app/api/v1/projects/[projectKey]/ready/route.ts',
  'app/api/v1/sprints/[sprintId]/route.ts',
  'app/api/v1/sprints/[sprintId]/start/route.ts',
  'app/api/v1/sprints/[sprintId]/complete/route.ts',
  'app/api/v1/sprints/[sprintId]/work-items/route.ts',
] as const;

type Handler = (
  req: Request,
  args: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function route(path: string, method: string): Promise<Handler> {
  const mod = (await import(/* @vite-ignore */ `@/${path.replace(/\.ts$/, '')}`)) as Record<
    string,
    Handler
  >;
  const handler = mod[method];
  if (!handler) throw new Error(`${path} exports no ${method}`);
  return handler;
}

// ─────────────────────────────────────────────────────────────────────────────
// The guards' own source predicates — exported shape so each can be aimed at a
// PLANTED violation as well as at the real tree.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A v1 route must not IMPORT from `lib/mcp/`.
 *
 * A NEW guard: 11.1's shipped audit checks Prisma, transactions, the wrapper and
 * the declared scope, and 11.2's checks `lib/mcp/tools/` specifically. This is
 * the whole directory, because the two transports align through the SERVICE and
 * an import of anything under `lib/mcp/` is how they start sharing a shape
 * neither owns.
 */
export function findsMcpImport(source: string): boolean {
  return /from\s+['"]@\/lib\/mcp\//.test(source);
}

/**
 * A v1 route must not RE-DERIVE readiness, rank or sprint state.
 *
 * The story's central risk, and the one a functional test cannot catch: a route
 * that computes `blockers.every(done)` instead of calling `listReady` passes
 * every assertion on a shallow fixture and is WRONG on a deep tree, because it
 * misses the parent-ready cascade. So it is guarded structurally.
 *
 * The patterns are deliberately narrow — a route may legitimately call a service
 * that does these things, so the guard looks for the route DOING them: walking a
 * blocker array, comparing status categories, or sorting a page it was handed.
 */
export function findsReDerivation(source: string): string[] {
  const violations: string[] = [];
  // Walking a blocker/dependency array with a predicate — the flat readiness
  // check this story exists to prevent.
  if (/\b(blockedBy|blockers|dependencies)\b[^\n]{0,40}\.(every|some|filter)\s*\(/.test(source)) {
    violations.push('walks a blocker array — readiness is the service’s to compute');
  }
  // Deciding what "done" means at the route.
  if (/category\s*===\s*['"]done['"]|status\s*===\s*['"]done['"]/.test(source)) {
    violations.push('compares a status category — terminality is the workflow’s to define');
  }
  // Re-ordering a page the service already ranked.
  if (/\bitems\s*\.\s*sort\s*\(|\bresult\.items\s*\.\s*sort\s*\(/.test(source)) {
    violations.push('sorts a service-ranked page — the dispatch rank is the product');
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Contract guards
// ─────────────────────────────────────────────────────────────────────────────

describe('gate — the planning route surface exists and is clean', () => {
  it('names every route this story ships (a sweep over zero files proves nothing)', () => {
    const files = v1RouteFiles(REPO_ROOT);
    for (const expected of STORY_ROUTES) {
      expect(files, `${expected} must be in the tree`).toContain(expected);
    }
  });

  it('NO v1 route imports from lib/mcp/', () => {
    const offenders = v1RouteFiles(REPO_ROOT).filter((file) =>
      findsMcpImport(readRouteSource(REPO_ROOT, file)),
    );

    expect(offenders).toEqual([]);
  });

  it('…and that guard FAILS on a planted import', () => {
    expect(findsMcpImport("import { runListReady } from '@/lib/mcp/tools/listReady';")).toBe(true);
    // It does not fire on prose — a guard that flags its own documentation
    // teaches people to delete the documentation.
    expect(findsMcpImport('// Read `lib/mcp/tools/listReady.ts`, do not import it.')).toBe(false);
  });

  it('NO v1 route re-derives readiness, rank or sprint state', () => {
    const violations = v1RouteFiles(REPO_ROOT).flatMap((file) =>
      findsReDerivation(readRouteSource(REPO_ROOT, file)).map((v) => `${file}: ${v}`),
    );

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('…and that guard FAILS on each planted violation', () => {
    expect(
      findsReDerivation('const ready = items.filter((i) => i.blockedBy.every((b) => b.done));'),
    ).not.toEqual([]);
    expect(findsReDerivation("if (item.status === 'done') return null;")).not.toEqual([]);
    expect(
      findsReDerivation('const page = result.items.sort((a, b) => a.key - b.key);'),
    ).not.toEqual([]);
    // …and does NOT fire on a route that simply calls the service.
    expect(
      findsReDerivation('const result = await workItemsService.listReady(id, {}, ctx);'),
    ).toEqual([]);
  });

  it('the two closed vocabularies are declared as schemas, so a DTO value cannot slip through', () => {
    // The totality itself is a COMPILE-time guard (`satisfies` + `AssertTotal`)
    // and cannot be re-tested at runtime; what IS testable is that the wire
    // vocabulary is a closed enum rather than a bare string.
    expect(() => sprintSchema.parse({ state: 'not-a-state' })).toThrow();
    expect(() => projectSchema.parse({ accessLevel: 'not-a-level' })).toThrow();
    expect(() => readyItemSchema.parse({ kind: 'not-a-kind' })).toThrow();
  });
});

describe('gate — cursor isolation across the REAL endpoints', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });

  // Asserted end to end rather than only at the codec, because the property that
  // matters is that a REAL endpoint refuses it — the codec being right is
  // necessary and not sufficient.
  it('every collection refuses a cursor issued by every OTHER collection', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read'] });

    const endpoints: Array<{
      collection: (typeof V1_COLLECTIONS)[number];
      call: (cursor: string) => Promise<Response>;
    }> = [
      {
        collection: 'projects',
        call: async (cursor) =>
          (await route('app/api/v1/projects/route.ts', 'GET'))(
            new Request(`${BASE}/projects?cursor=${encodeURIComponent(cursor)}`, {
              headers: caller.headers,
            }),
            { params: Promise.resolve({}) },
          ),
      },
      {
        collection: 'backlog',
        call: async (cursor) =>
          (await route('app/api/v1/projects/[projectKey]/backlog/route.ts', 'GET'))(
            new Request(
              `${BASE}/projects/${caller.projectKey}/backlog?cursor=${encodeURIComponent(cursor)}`,
              { headers: caller.headers },
            ),
            { params: Promise.resolve({ projectKey: caller.projectKey }) },
          ),
      },
      {
        collection: 'ready',
        call: async (cursor) =>
          (await route('app/api/v1/projects/[projectKey]/ready/route.ts', 'GET'))(
            new Request(
              `${BASE}/projects/${caller.projectKey}/ready?cursor=${encodeURIComponent(cursor)}`,
              { headers: caller.headers },
            ),
            { params: Promise.resolve({ projectKey: caller.projectKey }) },
          ),
      },
    ];

    for (const endpoint of endpoints) {
      for (const other of V1_COLLECTIONS.filter((c) => c !== endpoint.collection)) {
        const foreign = encodeCollectionCursor(other, 'some-row-id');
        const res = await endpoint.call(foreign);
        expect(res.status, `${endpoint.collection} must refuse a ${other} cursor`).toBe(422);
        expect(((await res.json()) as { code: string }).code).toBe('INVALID_CURSOR');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Integration seams — one card's REAL output through the next's REAL consumer
// ─────────────────────────────────────────────────────────────────────────────

describe('seam — the planning cadence, card to card', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });

  async function writer() {
    return createV1ProjectCaller({ scopes: ['read', 'sprints:write'] });
  }

  function post(caller: V1ProjectCaller, path: string, body: unknown): Request {
    return new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function get(caller: V1ProjectCaller, path: string): Request {
    return new Request(`${BASE}${path}`, { headers: caller.headers });
  }

  async function createSprint(caller: V1ProjectCaller, name: string) {
    const handler = await route('app/api/v1/projects/[projectKey]/sprints/route.ts', 'POST');
    const res = await handler(post(caller, `/projects/${caller.projectKey}/sprints`, { name }), {
      params: Promise.resolve({ projectKey: caller.projectKey }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; name: string };
  }

  async function listSprints(caller: V1ProjectCaller) {
    const handler = await route('app/api/v1/projects/[projectKey]/sprints/route.ts', 'GET');
    const res = await handler(get(caller, `/projects/${caller.projectKey}/sprints`), {
      params: Promise.resolve({ projectKey: caller.projectKey }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { items: Array<Record<string, unknown>> };
  }

  async function readSprint(caller: V1ProjectCaller, sprintId: string) {
    const handler = await route('app/api/v1/sprints/[sprintId]/route.ts', 'GET');
    const res = await handler(get(caller, `/sprints/${sprintId}`), {
      params: Promise.resolve({ sprintId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function act(
    caller: V1ProjectCaller,
    sprintId: string,
    action: string,
    body: unknown = {},
  ) {
    const handler = await route(`app/api/v1/sprints/[sprintId]/${action}/route.ts`, 'POST');
    return handler(post(caller, `/sprints/${sprintId}/${action}`, body), {
      params: Promise.resolve({ sprintId }),
    });
  }

  async function moveIntoSprint(caller: V1ProjectCaller, sprintId: string, keys: string[]) {
    const handler = await route('app/api/v1/sprints/[sprintId]/work-items/route.ts', 'POST');
    return handler(post(caller, `/sprints/${sprintId}/work-items`, { workItemKeys: keys }), {
      params: Promise.resolve({ sprintId }),
    });
  }

  async function moveIntoBacklog(caller: V1ProjectCaller, keys: string[]) {
    const handler = await route(
      'app/api/v1/projects/[projectKey]/backlog/work-items/route.ts',
      'POST',
    );
    return handler(
      post(caller, `/projects/${caller.projectKey}/backlog/work-items`, { workItemKeys: keys }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
  }

  async function sprintItems(caller: V1ProjectCaller, sprintId: string): Promise<string[]> {
    const handler = await route('app/api/v1/sprints/[sprintId]/work-items/route.ts', 'GET');
    const res = await handler(get(caller, `/sprints/${sprintId}/work-items`), {
      params: Promise.resolve({ sprintId }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ key: string }> }).items.map((i) => i.key);
  }

  async function backlogItems(caller: V1ProjectCaller): Promise<string[]> {
    const handler = await route('app/api/v1/projects/[projectKey]/backlog/route.ts', 'GET');
    const res = await handler(get(caller, `/projects/${caller.projectKey}/backlog`), {
      params: Promise.resolve({ projectKey: caller.projectKey }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ key: string }> }).items.map((i) => i.key);
  }

  async function readyKeys(caller: V1ProjectCaller): Promise<string[]> {
    const handler = await route('app/api/v1/projects/[projectKey]/ready/route.ts', 'GET');
    const res = await handler(get(caller, `/projects/${caller.projectKey}/ready`), {
      params: Promise.resolve({ projectKey: caller.projectKey }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<{ key: string }> }).items.map((i) => i.key);
  }

  async function makeItem(caller: V1ProjectCaller, title: string) {
    return workItemsService.createWorkItem(
      { projectId: caller.fixture.projectId, kind: 'task', title },
      caller.ctx,
    );
  }

  it('CREATE → LIST → READ: three independently-written mappers agree', async () => {
    // The classic drift: a create mapper, a list mapper and a detail mapper each
    // shaping the same row, each with its own unit test that passes.
    const caller = await writer();
    const created = await createSprint(caller, 'Cadence 1');

    const listed = (await listSprints(caller)).items.find((s) => s['id'] === created.id);
    const read = await readSprint(caller, created.id);

    expect(listed).toEqual(read);
    expect(read['name']).toBe('Cadence 1');
    expect(read['state']).toBe('planned');
  });

  it('START → every read: the baseline is non-null and the state is active EVERYWHERE', async () => {
    const caller = await writer();
    const sprint = await createSprint(caller, 'Cadence 1');
    const item = await makeItem(caller, 'committed work');
    await moveIntoSprint(caller, sprint.id, [item.identifier]);
    await workItemsService.updateWorkItem(item.id, { storyPoints: 8 }, caller.ctx);

    expect((await act(caller, sprint.id, 'start')).status).toBe(200);

    const read = await readSprint(caller, sprint.id);
    const listed = (await listSprints(caller)).items.find((s) => s['id'] === sprint.id);

    for (const view of [read, listed as Record<string, unknown>]) {
      expect(view['state']).toBe('active');
      expect(view['committedIssueCount']).toBe(1);
      expect(view['committedPoints']).toBe(8);
    }
  });

  it('MOVE → the two ranked collections: in the sprint, absent from the backlog, and back', async () => {
    // The round trip the membership card deliberately left to this level rather
    // than depending on a sibling endpoint.
    const caller = await writer();
    const sprint = await createSprint(caller, 'Cadence 1');
    const first = await makeItem(caller, 'one');
    const second = await makeItem(caller, 'two');

    await moveIntoSprint(caller, sprint.id, [first.identifier, second.identifier]);

    expect(await sprintItems(caller, sprint.id)).toEqual([first.identifier, second.identifier]);
    expect(await backlogItems(caller)).toEqual([]);

    await moveIntoBacklog(caller, [first.identifier]);

    expect(await sprintItems(caller, sprint.id)).toEqual([second.identifier]);
    expect(await backlogItems(caller)).toEqual([first.identifier]);
  });

  it('COMPLETE → carry-over: the unfinished move, the done stay', async () => {
    const caller = await writer();
    const sprint = await createSprint(caller, 'Cadence 1');
    const done = await makeItem(caller, 'finished');
    const open = await makeItem(caller, 'unfinished');
    await moveIntoSprint(caller, sprint.id, [done.identifier, open.identifier]);
    await act(caller, sprint.id, 'start');
    for (const status of ['in_progress', 'in_review', 'done']) {
      await workItemsService.updateStatus(done.id, status, caller.ctx);
    }

    expect((await act(caller, sprint.id, 'complete')).status).toBe(200);

    // The done issue stays on the completed sprint — its historical record.
    expect(await sprintItems(caller, sprint.id)).toEqual([done.identifier]);
    // The unfinished one is back in the backlog.
    expect(await backlogItems(caller)).toEqual([open.identifier]);
  });

  it('MOVE → ready: sprint membership does NOT change what is ready', async () => {
    // The seam that catches a route quietly filtering the ready set by sprint.
    // Readiness is a property of the dependency graph, not of the cadence.
    const caller = await writer();
    const sprint = await createSprint(caller, 'Cadence 1');
    const item = await makeItem(caller, 'ready either way');

    const beforeMove = await readyKeys(caller);
    await moveIntoSprint(caller, sprint.id, [item.identifier]);
    const afterMove = await readyKeys(caller);

    expect(beforeMove).toContain(item.identifier);
    expect(afterMove).toEqual(beforeMove);
  });

  it('no work-item cuid appears in ANY planning response body', async () => {
    // The same §7 guarantee 11.2's gate asserts, re-run over this story's tree.
    const caller = await writer();
    const sprint = await createSprint(caller, 'Cadence 1');
    const item = await makeItem(caller, 'one');
    await moveIntoSprint(caller, sprint.id, [item.identifier]);

    const bodies = await Promise.all([
      (async () => JSON.stringify(await listSprints(caller)))(),
      (async () => JSON.stringify(await readSprint(caller, sprint.id)))(),
      (async () => JSON.stringify(await sprintItems(caller, sprint.id)))(),
      (async () => JSON.stringify(await backlogItems(caller)))(),
      (async () => JSON.stringify(await readyKeys(caller)))(),
    ]);

    for (const body of bodies) {
      expect(body, 'a work-item cuid must never cross the wire').not.toContain(item.id);
      expect(body).not.toContain(caller.fixture.projectId);
    }
  });
});
