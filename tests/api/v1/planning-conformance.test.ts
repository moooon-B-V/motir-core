import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { startMcpHttpServer, type McpTestServer } from '../../helpers/mcpHttpServer';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { v1RouteFiles } from '../../helpers/v1RouteAudit';
import { truncateAuthTables } from '../../helpers/db';

// END-TO-END CONFORMANCE for the PLANNING resources (Story 11.3 · Subtask
// 11.3.11 — MOTIR-2068), written from the INTEGRATOR's seat rather than the
// codebase's: a real PAT, real HTTP over a real socket, the real route
// handlers, real Postgres. No service imports, no in-process shortcuts.
//
// ⚠️ EVERY assertion reads the WIRE — status, headers, JSON. A conformance suite
// that imports a service is testing the codebase, not the contract. Nothing
// below reaches for a repository to "just check" a row: if the API cannot show
// it, it is not shown.
//
// This is the Story's E2E in the form the Story actually has. There is no
// user-observable surface — no page, nothing a person watches — so it is exempt
// from the acceptance-video rule under its non-UI carve-out and accepts on its
// tests alone, exactly as 11.1 and 11.2 did. The client is `curl`, so the test
// is an HTTP client.

let server: McpTestServer;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});
afterAll(async () => {
  await server.close();
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

interface SprintBody {
  id: string;
  name: string;
  state: string;
  issueCount: number;
  committedPoints: number | null;
  committedIssueCount: number | null;
}

interface KeyedPage {
  items: Array<{ key: string }>;
  nextCursor: string | null;
  totalCount?: number;
}

describe('/api/v1 planning conformance — an external client with a real PAT', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    // `work_items:write` too: the cadence starts by CREATING work, and an
    // external client has only 11.2's endpoint to do it with. Two scopes on one
    // token is what a real planning integration holds.
    caller = await createV1ProjectCaller({
      scopes: ['read', 'sprints:write', 'work_items:write'],
    });
  });

  /** Create a work item the ONLY way an external client can — over 11.2's API. */
  async function createItem(title: string): Promise<string> {
    const res = await http(`/api/v1/projects/${caller.projectKey}/work-items`, caller, {
      method: 'POST',
      body: { kind: 'task', title },
    });
    expect(res.status, `creating ${title}`).toBe(201);
    return (await json<{ key: string }>(res)).key;
  }

  // ⚠️ THE CADENCE, in one pass, as ONE client. Each step consumes ONLY what the
  // previous step returned — the project key, the sprint id, the item keys — so
  // a break anywhere in the chain fails the test rather than being papered over
  // by a fixture that knew the answer already.
  it('drives the whole cadence: discover → plan a sprint → commit work → start → track → complete', async () => {
    // ── 1. DISCOVER. A client holding a fresh PAT knows its workspace and
    // nothing about what is in it.
    const projects = await json<KeyedPage>(await http('/api/v1/projects', caller));
    expect(projects.items.map((p) => p.key)).toContain(caller.projectKey);

    const projectKey = projects.items[0]?.key as string;
    const project = await json<{ key: string; name: string }>(
      await http(`/api/v1/projects/${projectKey}`, caller),
    );
    expect(project.key).toBe(projectKey);

    // ── 2. The cadence starts EMPTY, and says so with 200 rather than 404.
    const noSprints = await json<KeyedPage>(
      await http(`/api/v1/projects/${projectKey}/sprints`, caller),
    );
    expect(noSprints).toEqual({ items: [], nextCursor: null });

    // ── 3. PLAN a sprint. The Location header names the resource, and the
    // client follows it rather than assembling a URL of its own.
    const createRes = await http(`/api/v1/projects/${projectKey}/sprints`, caller, {
      method: 'POST',
      body: { name: 'Cadence 1', goal: 'prove the API' },
    });
    expect(createRes.status).toBe(201);
    const location = createRes.headers.get('Location');
    expect(location).toBeTruthy();
    const created = await json<SprintBody>(createRes);

    const readBack = await json<SprintBody>(await http(location as string, caller));
    expect(readBack).toEqual(created);
    expect(readBack.state).toBe('planned');
    // A sprint that has never started has NO baseline — null, not zero.
    expect(readBack.committedIssueCount).toBeNull();
    expect(readBack.committedPoints).toBeNull();

    // ── 4. COMMIT work. Two items, created over the API, moved in as one batch.
    const first = await createItem('first');
    const second = await createItem('second');

    const backlogBefore = await json<KeyedPage>(
      await http(`/api/v1/projects/${projectKey}/backlog`, caller),
    );
    expect(backlogBefore.items.map((i) => i.key)).toEqual([first, second]);
    expect(backlogBefore.totalCount).toBe(2);

    const moveIn = await http(`/api/v1/sprints/${created.id}/work-items`, caller, {
      method: 'POST',
      body: { workItemKeys: [first, second] },
    });
    expect(moveIn.status).toBe(200);
    expect(await json<{ movedKeys: string[] }>(moveIn)).toEqual({ movedKeys: [first, second] });

    // The two ranked collections now agree about where the work is.
    const members = await json<KeyedPage>(
      await http(`/api/v1/sprints/${created.id}/work-items`, caller),
    );
    expect(members.items.map((i) => i.key)).toEqual([first, second]);
    const backlogAfter = await json<KeyedPage>(
      await http(`/api/v1/projects/${projectKey}/backlog`, caller),
    );
    expect(backlogAfter.items).toEqual([]);

    // ── 5. START. The baseline becomes observable on every sprint read.
    const startRes = await http(`/api/v1/sprints/${created.id}/start`, caller, {
      method: 'POST',
      body: {},
    });
    expect(startRes.status).toBe(200);
    expect((await json<SprintBody>(startRes)).state).toBe('active');

    const started = await json<SprintBody>(await http(`/api/v1/sprints/${created.id}`, caller));
    expect(started.committedIssueCount).toBe(2);
    expect(started.issueCount).toBe(2);
    // The list agrees with the single read, field for field.
    const sprintList = await json<{ items: SprintBody[] }>(
      await http(`/api/v1/projects/${projectKey}/sprints`, caller),
    );
    expect(sprintList.items.find((s) => s.id === created.id)).toEqual(started);

    // ── 6. TRACK. The ready set answers "what do I pick up next?" and carries
    // the downstream impact of each row.
    const ready = await json<{
      items: Array<{ key: string; dependencies: { blockedBy: unknown[]; blocks: unknown[] } }>;
    }>(await http(`/api/v1/projects/${projectKey}/ready`, caller));
    expect(ready.items.map((i) => i.key)).toEqual([first, second]);
    // Both arrays are always present, even with no edges.
    expect(ready.items[0]?.dependencies).toEqual({ blockedBy: [], blocks: [] });

    // ── 7. COMPLETE. The unfinished work returns to the backlog in rank order.
    const completeRes = await http(`/api/v1/sprints/${created.id}/complete`, caller, {
      method: 'POST',
      body: {},
    });
    expect(completeRes.status).toBe(200);
    expect((await json<SprintBody>(completeRes)).state).toBe('complete');

    const backlogFinal = await json<KeyedPage>(
      await http(`/api/v1/projects/${projectKey}/backlog`, caller),
    );
    expect(backlogFinal.items.map((i) => i.key)).toEqual([first, second]);
  });

  it('stamps a request id and the rate-limit headers on every planning response', async () => {
    const paths = [
      '/api/v1/projects',
      `/api/v1/projects/${caller.projectKey}`,
      `/api/v1/projects/${caller.projectKey}/sprints`,
      `/api/v1/projects/${caller.projectKey}/backlog`,
      `/api/v1/projects/${caller.projectKey}/ready`,
    ];

    for (const path of paths) {
      const res = await http(path, caller);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-request-id'), `${path} carries a request id`).toBeTruthy();
      expect(res.headers.get('x-ratelimit-limit'), `${path} carries the budget`).toBeTruthy();
    }
  });

  it('refuses every planning endpoint without a token, and every WRITE without the scope', async () => {
    const sprint = await json<SprintBody>(
      await http(`/api/v1/projects/${caller.projectKey}/sprints`, caller, {
        method: 'POST',
        body: { name: 'Cadence 1' },
      }),
    );
    const readOnly = await createV1ProjectCaller({ scopes: ['read'] });

    // No credential at all → 401, undifferentiated.
    const anonymous = await http('/api/v1/projects', null);
    expect(anonymous.status).toBe(401);
    expect(await json<{ code: string }>(anonymous)).toEqual({
      code: 'UNAUTHENTICATED',
      error: expect.any(String),
    });

    // A valid credential lacking the scope → 403, on every write.
    const writes: Array<[string, unknown]> = [
      [`/api/v1/projects/${caller.projectKey}/sprints`, { name: 'nope' }],
      [`/api/v1/sprints/${sprint.id}/start`, {}],
      [`/api/v1/sprints/${sprint.id}/complete`, {}],
      [`/api/v1/sprints/${sprint.id}/work-items`, { workItemKeys: [] }],
      [`/api/v1/projects/${caller.projectKey}/backlog/work-items`, { workItemKeys: [] }],
    ];
    for (const [path, body] of writes) {
      const res = await http(path, readOnly, { method: 'POST', body });
      expect(res.status, `${path} refuses a read-only token`).toBe(403);
      expect((await json<{ code: string }>(res)).code).toBe('INSUFFICIENT_SCOPE');
    }
  });

  it('answers another tenant with 404 — never 403 — on every keyed planning path', async () => {
    const other = await createV1ProjectCaller({
      workspaceName: 'Other Co',
      identifier: 'OTHER',
      scopes: ['read', 'sprints:write'],
    });
    const theirSprint = await json<SprintBody>(
      await http(`/api/v1/projects/${other.projectKey}/sprints`, other, {
        method: 'POST',
        body: { name: 'Theirs' },
      }),
    );

    const paths = [
      `/api/v1/projects/${other.projectKey}`,
      `/api/v1/projects/${other.projectKey}/sprints`,
      `/api/v1/projects/${other.projectKey}/backlog`,
      `/api/v1/projects/${other.projectKey}/ready`,
      `/api/v1/sprints/${theirSprint.id}`,
      `/api/v1/sprints/${theirSprint.id}/work-items`,
    ];

    for (const path of paths) {
      const res = await http(path, caller);
      // A 403 would confirm the resource EXISTS — an existence oracle over
      // another tenant's data (ADR §4).
      expect(res.status, `${path} must be 404, never 403`).toBe(404);
    }
  });

  it('never answers a malformed planning request with a 500 or a leaked internal', async () => {
    const probes = [
      `/api/v1/projects/${caller.projectKey}/backlog?limit=0`,
      `/api/v1/projects/${caller.projectKey}/backlog?cursor=zzz`,
      `/api/v1/projects/${caller.projectKey}/backlog?filter=garbage`,
      `/api/v1/projects/${caller.projectKey}/ready?cursor=zzz`,
      `/api/v1/projects/${caller.projectKey}/ready?kind=nonsense`,
      '/api/v1/projects/NOPE/sprints',
      '/api/v1/sprints/not-a-sprint-id',
      '/api/v1/sprints/not-a-sprint-id/work-items',
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

  it('rejects a whole membership batch over the wire when one member is unknown', async () => {
    // The atomicity guarantee, asserted from outside: the good member is still
    // in the backlog afterwards, which is the only thing an external client can
    // actually observe.
    const sprint = await json<SprintBody>(
      await http(`/api/v1/projects/${caller.projectKey}/sprints`, caller, {
        method: 'POST',
        body: { name: 'Cadence 1' },
      }),
    );
    const good = await createItem('good');

    const res = await http(`/api/v1/sprints/${sprint.id}/work-items`, caller, {
      method: 'POST',
      body: { workItemKeys: [good, 'PROD-99999'] },
    });

    expect(res.status).toBe(404);
    const members = await json<KeyedPage>(
      await http(`/api/v1/sprints/${sprint.id}/work-items`, caller),
    );
    expect(members.items).toEqual([]);
    const backlog = await json<KeyedPage>(
      await http(`/api/v1/projects/${caller.projectKey}/backlog`, caller),
    );
    expect(backlog.items.map((i) => i.key)).toEqual([good]);
  });

  // ⚠️ A conformance suite that silently misses an endpoint proves nothing.
  it('fails loudly if a planning endpoint is added without a conformance step', () => {
    const covered = [
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
    ];

    // This story's surface: everything under `/sprints`, plus the project-level
    // paths it added. `projects/[projectKey]/work-items` is 11.2's and has its
    // own conformance suite.
    const shipped = v1RouteFiles(process.cwd()).filter(
      (f) =>
        f.includes('/sprints') ||
        f.includes('/backlog') ||
        f.includes('/ready') ||
        /projects\/(route\.ts|\[projectKey\]\/route\.ts)$/.test(f),
    );

    // Enumerated rather than counted: a NEW planning endpoint appears here as a
    // failure naming the file, which is the prompt to add its journey step.
    expect([...shipped].sort()).toEqual([...covered].sort());
  });
});
