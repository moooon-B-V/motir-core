import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONLY thing stubbed in this whole file, and it is not part of the surface
// under test: motir-ai is a second process this suite has no way to run. Every
// other hop — the socket, the wrapper, the scope gate, the limiter, the error
// envelope, Postgres — is real.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(async () => ({ jobId: 'job_conformance' })),
  getJob: vi.fn(),
}));

import { getJob } from '@/lib/ai/motirAiClient';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { responseSchemaFor } from '../../helpers/v1SpecConformance';
import { startMcpHttpServer, type McpTestServer } from '../../helpers/mcpHttpServer';
import {
  createV1ProjectCaller,
  withTokenFor,
  type V1ProjectCaller,
} from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// END-TO-END CONFORMANCE for the WORK-LOOP operations (Story 11.7 · Subtask
// 11.7.9 — MOTIR-2243), written from the INTEGRATOR's seat: a real PAT, real
// HTTP over a real socket, the real route handlers, real Postgres. No service
// imports, no in-process shortcuts, no cookie session.
//
// ⚠️ WHY THIS EXISTS BESIDE 11.7.8. That card drives services and schemas
// IN-PROCESS. This one goes over the wire, through `withV1Route` — auth, the
// scope gate, the rate limiter, the error envelope, the request id — and is
// therefore the only test that exercises the surface a third party actually
// meets. **A route can be perfect in-process and unreachable in practice**: a
// mis-declared scope, a path that does not match, a param that arrives
// undecoded. Only this catches that.
//
// ⚠️ EVERY assertion reads the WIRE — status, headers, JSON. Nothing below
// reaches for a service or a repository to "just check" a row: if the API cannot
// show it, it is not shown.
//
// This is the Story's E2E in the form the Story has. There is no user-observable
// surface — no page, no panel, nothing a person watches — so it is exempt from
// the acceptance-video rule under its non-UI carve-out, exactly as Stories
// 11.1–11.3 were. A Playwright test would be theatre: the client is `curl`.

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
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(caller?.headers ?? {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Assert one response against the schema THE DOCUMENT declares for that
 * operation.
 *
 * The schema is looked up by the (method, path) the client actually called,
 * through the registry the OpenAPI document is emitted from — never imported
 * beside the assertion. So a response validated against the wrong operation's
 * shape, or served from a path with no declaration at all, fails here. The
 * document itself is checked too: it must carry that path, that verb and that
 * success status, which is what ties "the schema I validated against" to "the
 * schema a client generated its code from".
 */
function conforms(res: Response, method: string, path: string, body: unknown): void {
  const operation = findV1Operation(method, path);
  expect(operation, `${method} ${path} is a declared operation`).toBeDefined();
  expect(res.status, `${method} ${path} answers its declared status`).toBe(
    operation?.response.status,
  );

  const document = emitOpenApiDocument() as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const declared = document.paths[path]?.[method.toLowerCase()];
  expect(declared, `${method} ${path} appears in the emitted document`).toBeDefined();
  expect(Object.keys(declared?.responses ?? {})).toContain(String(operation?.response.status));

  const schema = responseSchemaFor(operation!);
  const parsed = schema?.safeParse(body);
  expect(
    parsed?.success,
    `${method} ${path} body: ${parsed?.success ? '' : JSON.stringify(parsed?.error.issues)}`,
  ).toBe(true);
}

describe('/api/v1 work-loop conformance — an external client with a real PAT', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    vi.clearAllMocks();
    caller = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'integration'],
    });
  });

  // ⚠️ THE WALK, in ONE pass, as ONE client. Each step consumes only what the
  // previous step returned — the ready key, the plan id, the branch it recorded
  // — so a break anywhere in the chain fails the test rather than being papered
  // over by a fixture that already knew the answer.
  it('walks the whole loop: ready → prompt → read → activity → integrate → close out', async () => {
    const project = `/api/v1/projects/${caller.projectKey}`;

    // ── 1. Seed the work through the PUBLIC create endpoint ─────────────────
    // Even the fixture is an HTTP call: nothing in this file may know something
    // the API cannot tell it.
    const created = await http(`${project}/work-items`, caller, {
      method: 'POST',
      body: { kind: 'story', title: 'a story to run' },
    });
    expect(created.status).toBe(201);
    const parentKey = (await json<{ key: string }>(created)).key;

    const child = await http(`${project}/work-items`, caller, {
      method: 'POST',
      body: { kind: 'subtask', title: 'the leaf to dispatch', parentKey },
    });
    expect(child.status).toBe(201);
    const childKey = (await json<{ key: string }>(child)).key;

    // ── 2. FIND READY WORK ──────────────────────────────────────────────────
    const readyRes = await http(`${project}/ready`, caller);
    const ready = await json<{ items: { key: string }[] }>(readyRes);
    conforms(readyRes, 'GET', '/api/v1/projects/{projectKey}/ready', ready);
    expect(ready.items.map((i) => i.key)).toContain(childKey);

    // ── 3. FETCH ITS DISPATCH PROMPT ────────────────────────────────────────
    const promptRes = await http(`/api/v1/work-items/${childKey}/dispatch-prompt`, caller);
    const prompt = await json<{ key: string; prompt: string; workflowMode: string }>(promptRes);
    conforms(promptRes, 'GET', '/api/v1/work-items/{key}/dispatch-prompt', prompt);
    expect(prompt.key).toBe(childKey);
    expect(prompt.prompt).toContain(childKey);

    // ── 4. READ THE ITEM IN FULL — children's edges and the readiness verdict ─
    const detailRes = await http(`/api/v1/work-items/${parentKey}`, caller);
    const detail = await json<{
      children: { key: string; dependencies: { blockedBy: unknown[]; blocks: unknown[] } }[];
      readiness: { blockedByAncestorKey: string | null; blockedByAncestorTitle: string | null };
    }>(detailRes);
    conforms(detailRes, 'GET', '/api/v1/work-items/{key}', detail);
    // 11.7.2's projections, over the wire: the child's edge block is present and
    // TOTAL, and readiness carries the ancestor pair.
    expect(detail.children[0]?.dependencies).toEqual({ blockedBy: [], blocks: [] });
    expect(detail.readiness).toHaveProperty('blockedByAncestorTitle');

    // ── 5. READ ITS ACTIVITY ────────────────────────────────────────────────
    const activityRes = await http(`/api/v1/work-items/${childKey}/activity`, caller);
    const activity = await json<{ items: { type: string }[]; totalCount: number }>(activityRes);
    conforms(activityRes, 'GET', '/api/v1/work-items/{key}/activity', activity);
    expect(activity.items.some((e) => e.type === 'change')).toBe(true);

    // ── 6. RECORD IT INTEGRATED ─────────────────────────────────────────────
    // The item has to be in progress first, and even THAT goes over the wire.
    const moved = await http(`/api/v1/work-items/${childKey}/transitions`, caller, {
      method: 'POST',
      body: { status: 'in_progress' },
    });
    expect(moved.status).toBe(200);

    const branch = 'subtask/MOTIR-2243-conformance';
    const integratedRes = await http(`/api/v1/work-items/${childKey}/integration`, caller, {
      method: 'POST',
      body: { sessionBranch: branch, implementationHarness: 'curl' },
    });
    const integrated = await json<{ key: string; status: string; sessionBranch: string | null }>(
      integratedRes,
    );
    conforms(integratedRes, 'POST', '/api/v1/work-items/{key}/integration', integrated);
    expect(integrated.status).toBe('in_review');
    expect(integrated.sessionBranch).toBe(branch);

    // ── 7. CLOSE THE BRANCH OUT ─────────────────────────────────────────────
    // The branch contains a `/`, which is why it rides in the body.
    const closedRes = await http('/api/v1/sessions/complete', caller, {
      method: 'POST',
      body: { sessionBranch: branch },
    });
    const closed = await json<{
      sessionBranch: string;
      results: { key: string; outcome: string }[];
    }>(closedRes);
    conforms(closedRes, 'POST', '/api/v1/sessions/complete', closed);
    expect(closed.sessionBranch).toBe(branch);
    expect(closed.results).toEqual([{ key: childKey, outcome: 'completed' }]);

    // ── THE LOOP CLOSES, and it is asserted rather than implied ─────────────
    // Read back over `/api/v1` — the only surface this walk has touched. A third
    // party holding one PAT found work, was told how to do it, recorded doing it
    // and closed it out, with no MCP call and no web-app action anywhere.
    const finalRes = await http(`/api/v1/work-items/${childKey}`, caller);
    const final = await json<{ status: string }>(finalRes);
    expect(final.status, 'the loop CLOSES — the item ends done').toBe('done');

    const stillReady = await json<{ items: { key: string }[] }>(
      await http(`${project}/ready`, caller),
    );
    expect(stillReady.items.map((i) => i.key)).not.toContain(childKey);

    // …and every request in the walk went to `/api/v1`. Nothing reached
    // `/api/mcp` and nothing reached a web-app route, which is the CLAIM being
    // proven: "a third party can run the whole loop."
    const paths = server.requests.map((r) => r.pathname);
    expect(paths.length).toBeGreaterThan(8);
    expect(paths.every((p) => p.startsWith('/api/v1/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/api/mcp'))).toBe(false);
  });

  // ⚠️ The PLANNING half of the loop, separately: it is a different resource
  // with a different address, and it ends at a Plan rather than at a done item.
  it('walks the planning loop: open by scope → append → submit → poll → read the proposals', async () => {
    const project = `/api/v1/projects/${caller.projectKey}`;

    const openedRes = await http(`${project}/plan-session`, caller, { method: 'POST', body: {} });
    const opened = await json<{ id: string; turnCount: number }>(openedRes);
    conforms(openedRes, 'POST', '/api/v1/projects/{projectKey}/plan-session', opened);
    expect(opened.turnCount).toBe(0);

    const appendedRes = await http(`${project}/plan-session/turns`, caller, {
      method: 'POST',
      body: { body: 'split the billing epic, and keep every leaf under three points' },
    });
    const appended = await json<{ id: string; turnCount: number; lastJobId: string | null }>(
      appendedRes,
    );
    conforms(appendedRes, 'POST', '/api/v1/projects/{projectKey}/plan-session/turns', appended);
    // The SAME thread, resumed by scope — not a second one.
    expect(appended.id).toBe(opened.id);
    expect(appended.turnCount).toBe(1);
    // Appending is not submitting.
    expect(appended.lastJobId).toBeNull();

    const submittedRes = await http(`${project}/plan-session/submissions`, caller, {
      method: 'POST',
      body: {},
    });
    const handle = await json<{ jobId: string; planId: string; statusUrl: string }>(submittedRes);
    conforms(
      submittedRes,
      'POST',
      '/api/v1/projects/{projectKey}/plan-session/submissions',
      handle,
    );
    expect(submittedRes.status).toBe(202);

    // ── POLL, at the address the handle gave — never one the client assembled ─
    vi.mocked(getJob).mockResolvedValue({ status: 'running' } as Awaited<
      ReturnType<typeof getJob>
    >);
    const statusRes = await http(handle.statusUrl, caller);
    const status = await json<{ status: string; proposalCount: number; job: unknown }>(statusRes);
    conforms(statusRes, 'GET', '/api/v1/plans/{planId}/status', status);
    expect(status.status).toBe('generating');

    const planRes = await http(`/api/v1/plans/${handle.planId}`, caller);
    const plan = await json<{ proposals: unknown[]; proposalCount: number }>(planRes);
    conforms(planRes, 'GET', '/api/v1/plans/{planId}', plan);
    expect(plan.proposalCount).toBe(0);

    const paths = server.requests.map((r) => r.pathname);
    expect(paths.every((p) => p.startsWith('/api/v1/'))).toBe(true);
  });

  it('reports a plan whose job DIED as dead, not as pending', async () => {
    // The case a client would otherwise poll forever on: nothing writes a
    // terminal plan state when a job fails, so the plan sits at `generating`.
    const project = `/api/v1/projects/${caller.projectKey}`;
    await http(`${project}/plan-session/turns`, caller, {
      method: 'POST',
      body: { body: 'plan something' },
    });
    const handle = await json<{ planId: string; statusUrl: string }>(
      await http(`${project}/plan-session/submissions`, caller, { method: 'POST', body: {} }),
    );
    vi.mocked(getJob).mockResolvedValue({
      status: 'failed',
      error: { code: 'PLANNER_CRASHED', message: 'the model returned nothing' },
    } as Awaited<ReturnType<typeof getJob>>);

    const body = await json<{
      status: string;
      job: { reachable: boolean; failure: { code: string } | null } | null;
    }>(await http(handle.statusUrl, caller));

    expect(body.status).toBe('generating');
    expect(body.job?.reachable).toBe(true);
    expect(body.job?.failure?.code).toBe('PLANNER_CRASHED');
  });

  // ── The refusals, over the wire ────────────────────────────────────────────

  it('answers an EMPTY ready set with 200 and no items, never a 404', async () => {
    const empty = await createV1ProjectCaller({ scopes: ['read'] });
    const res = await http(`/api/v1/projects/${empty.projectKey}/ready`, empty);
    expect(res.status).toBe(200);
    expect((await json<{ items: unknown[] }>(res)).items).toEqual([]);
  });

  it.each([
    ['read', '/api/v1/work-items/%KEY%/dispatch-prompt', 'GET', undefined],
    ['integration', '/api/v1/work-items/%KEY%/integration', 'POST', { sessionBranch: 'session/x' }],
    ['work_items:write', '/api/v1/work-items/%KEY%/expansions', 'POST', undefined],
  ])(
    'refuses a token missing the `%s` scope with 403 + INSUFFICIENT_SCOPE',
    async (_scope, template, method, body) => {
      // Once per DISTINCT scope this story uses. A token holding every OTHER
      // scope still cannot do this, which is what makes each gate load-bearing
      // rather than decorative.
      const created = await http(`/api/v1/projects/${caller.projectKey}/work-items`, caller, {
        method: 'POST',
        body: { kind: 'story', title: 'gated' },
      });
      const key = (await json<{ key: string }>(created)).key;
      const other = await withTokenFor(caller.user, caller.workspace, {
        scopes: ['sprints:write'],
      });

      const res = await http(template.replace('%KEY%', key), other, {
        method,
        ...(body === undefined ? {} : { body }),
      });

      expect(res.status).toBe(403);
      expect((await json<{ code: string }>(res)).code).toBe('INSUFFICIENT_SCOPE');
    },
  );

  it('answers 404 — never 403 — for a key in another workspace', async () => {
    const theirs = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      identifier: 'OTHR',
    });
    const created = await http(`/api/v1/projects/${theirs.projectKey}/work-items`, theirs, {
      method: 'POST',
      body: { kind: 'story', title: 'theirs' },
    });
    const hidden = (await json<{ key: string }>(created)).key;

    for (const path of [
      `/api/v1/work-items/${hidden}/dispatch-prompt`,
      `/api/v1/work-items/${hidden}/activity`,
    ]) {
      const res = await http(path, caller);
      expect(res.status, path).toBe(404);
    }
  });

  it('answers 404 for an unknown work-item key, and 422 for a malformed one', async () => {
    expect(
      (await http(`/api/v1/work-items/${caller.projectKey}-99999/dispatch-prompt`, caller)).status,
    ).toBe(404);
    expect((await http('/api/v1/work-items/not-a-key/dispatch-prompt', caller)).status).toBe(422);
  });

  it('refuses a submit on an EMPTY thread with 422 + its code', async () => {
    const project = `/api/v1/projects/${caller.projectKey}`;
    await http(`${project}/plan-session`, caller, { method: 'POST', body: {} });

    const res = await http(`${project}/plan-session/submissions`, caller, {
      method: 'POST',
      body: {},
    });

    expect(res.status).toBe(422);
    expect((await json<{ code: string }>(res)).code).toBe('PLAN_CHANGE_EMPTY_INTENT');
  });

  it('rate-limits a work-loop call with 429, headers and the error envelope', async () => {
    process.env['MOTIR_API_V1_RATE_LIMIT'] = '2';
    process.env['MOTIR_API_V1_RATE_LIMIT_WINDOW_MS'] = '60000';
    resetRateLimitStore();
    const limited = await createV1ProjectCaller({ scopes: ['read'] });
    const created = await http(`/api/v1/projects/${caller.projectKey}/work-items`, caller, {
      method: 'POST',
      body: { kind: 'story', title: 'rate limited' },
    });
    const key = (await json<{ key: string }>(created)).key;
    const path = `/api/v1/work-items/${key}/dispatch-prompt`;

    // The budget is 2, and the third call must be refused. The first two answer
    // 404 (the item is in the OTHER caller's project) — which is fine and is the
    // point: a refusal is metered too, so the limiter cannot be sidestepped by
    // asking for something you may not have.
    await http(path, limited);
    await http(path, limited);
    const third = await http(path, limited);

    expect(third.status).toBe(429);
    expect(third.headers.get('x-ratelimit-limit')).toBe('2');
    expect(third.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(third.headers.get('x-request-id')).toBeTruthy();
    expect((await json<{ code: string; error: string }>(third)).code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('answers 401 to a caller with no token at all', async () => {
    const res = await http('/api/v1/work-items/MOTIR-1/dispatch-prompt', null);
    expect(res.status).toBe(401);
  });
});
