import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Story MOTIR-8538 · MOTIR-8676 — the run-lifecycle scenario's pure halves, and
// one iteration replayed against the shipped `/api/v1` route handlers on a real
// Postgres with a seeded `run` agent's token. k6 itself is not run here.

vi.hoisted(() => {
  process.env['E2E_DISABLE_RATE_LIMIT'] = '1';
});

const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

const { adminDb } = await import('../helpers/adminDb');
const { findV1Operation } = await import('@/lib/api/v1/openapi/registry');
const { resetRateLimitStore } = await import('@/lib/api/v1/rateLimit');
const {
  dispatchRunAppendBodySchema,
  dispatchRunCloseBodySchema,
  dispatchRunOpenBodySchema,
  dispatchRunOpenedSchema,
} = await import('@/lib/api/v1/workLoop/schema');
const cli = await import('../../packages/cli/src/dispatchRunReporter');
const { truncateAuthTables } = await import('../helpers/db');
const { seedTenants } = await import('@/loadtest/seed/tenants');
const { SMOKE_SHAPE } = await import('@/loadtest/seed/shape');
const { EMPTY, ERROR, LIMITED, OK, OUTCOMES } = await import('@/loadtest/k6/lib/outcome.js');
const seq = await import('@/loadtest/k6/runs/sequence.js');
const { classifyRunResponse } = await import('@/loadtest/k6/runs/classify.js');
const { recordRunStep, ROLE_RUN } = await import('@/loadtest/k6/runs/metrics.js');

type Req = {
  op: string;
  step: string;
  params: Record<string, string>;
  body?: unknown;
  atMs?: number;
};

const ITER = {
  key: 'PROD-1',
  projectKey: 'PROD',
  agentSeconds: 12,
  recycle: true,
  logEventsPerBeat: 0,
  idempotencyKey: 'lt-1-0-1',
};

describe('sequence.js — the CLI order, restated', () => {
  it('runs read → claim → prompt → open → beat → two immediate batches → … → close', () => {
    const reqs = seq.iterationRequests({ ...ITER, agentSeconds: 60 }) as Req[];
    expect(reqs.map((r) => r.op)).toEqual([
      'getMe',
      'listWorkspaces',
      'getWorkItem',
      'claimWorkItem',
      'getWorkItemDispatchPrompt',
      'openDispatchRun',
      'heartbeatDispatchRun',
      'appendDispatchRunEvents',
      'appendDispatchRunEvents',
      'listWorkItemDesigns',
      'appendDispatchRunEvents',
      'heartbeatDispatchRun',
      'getWorkItem',
      'appendDispatchRunEvents',
      'closeDispatchRun',
      'updateWorkItem',
      'transitionWorkItem',
    ]);
    const batches = reqs
      .filter((r) => r.op === 'appendDispatchRunEvents')
      .map((r) => (r.body as { events: Array<{ kind: string }> }).events.map((e) => e.kind));
    expect(batches).toEqual([
      ['run_opened'],
      ['checkout_ready'],
      ['prompt_issued', 'agent_started'],
      ['agent_exited', 'leg_verdict'],
    ]);
  });

  it('every body parses with the server schemas; no batch over 200; no event body', () => {
    const reqs = seq.iterationRequests({ ...ITER, agentSeconds: 600, logEventsPerBeat: 150 });
    for (const r of reqs as Req[]) {
      if (r.op === 'openDispatchRun') dispatchRunOpenBodySchema.parse(r.body);
      if (r.op === 'closeDispatchRun') dispatchRunCloseBodySchema.parse(r.body);
      if (r.op === 'appendDispatchRunEvents') {
        const body = dispatchRunAppendBodySchema.parse(r.body);
        expect(body.events.length).toBeLessThanOrEqual(200);
        for (const e of body.events) expect(e.body).toBeUndefined();
      }
    }
  });

  it('never reports a delivery, a CI verdict, a settled card or an integrated leg', () => {
    const kinds = (seq.iterationRequests(ITER) as Req[])
      .filter((r) => r.op === 'appendDispatchRunEvents')
      .flatMap((r) => (r.body as { events: Array<{ kind: string; disposition?: string }> }).events);
    for (const bad of ['delivery_linked', 'ci_verdict', 'card_settled', 'run_closed']) {
      expect(kinds.map((e) => e.kind)).not.toContain(bad);
    }
    expect(kinds.map((e) => e.disposition).filter(Boolean)).toEqual(['running']);
  });

  it('the path table is the v1 registry', () => {
    for (const [op, def] of Object.entries(seq.RUN_OPERATIONS)) {
      expect(findV1Operation(def.method, def.path)?.operationId, op).toBe(op);
    }
  });

  it('the restated reporter constants equal the CLI', () => {
    expect(new Set(seq.FLUSH_ON_ENQUEUE)).toEqual(new Set(cli.FLUSH_ON_ENQUEUE));
    expect(seq.RUN_HEARTBEAT_INTERVAL_MS).toBe(cli.RUN_HEARTBEAT_INTERVAL_MS);
    expect(seq.REPORTER_BATCH_LIMIT).toBe(cli.REPORTER_BATCH_LIMIT);
  });

  it('requestsPerIteration counts the plan, and grows by two per interval with logs', () => {
    const count = (o: object) => seq.iterationRequests({ ...ITER, ...o }).length;
    expect(seq.requestsPerIteration({ agentSeconds: 12, recycle: true })).toBe(count({}));
    expect(seq.requestsPerIteration({ agentSeconds: 12, recycle: true })).toBe(15);
    expect(seq.requestsPerIteration({ agentSeconds: 12, recycle: false })).toBe(13);
    const withLogs = (s: number) =>
      seq.requestsPerIteration({ agentSeconds: s, recycle: true, logEventsPerBeat: 1 });
    expect(withLogs(120) - withLogs(60)).toBe(2);
    expect(withLogs(180) - withLogs(120)).toBe(2);
  });

  it('gives each run agent a disjoint slice of its project pool', () => {
    const pool = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, key: `P-${i}` }));
    const manifest = {
      projects: [{ id: 'p', pools: { run: pool } }],
      agents: [
        { tokenId: 'a', role: 'run', projectId: 'p' },
        { tokenId: 'b', role: 'run', projectId: 'p' },
        { tokenId: 'c', role: 'write', projectId: 'p' },
      ],
    };
    const a = seq.runSlice(manifest, manifest.agents[0]);
    const b = seq.runSlice(manifest, manifest.agents[1]);
    expect(a.map((c: { key: string }) => c.key)).toEqual(['P-0', 'P-2', 'P-4']);
    expect(b.map((c: { key: string }) => c.key)).toEqual(['P-1', 'P-3']);
    expect(seq.runSlice({ ...manifest, projects: [{ id: 'p', pools: { run: [] } }] }, a)).toEqual(
      [],
    );
  });
});

describe('classifyRunResponse and the metric helper', () => {
  it('claim taken / not_claimable is empty; claimed / mine is ok', () => {
    for (const outcome of ['taken', 'not_claimable']) {
      expect(
        classifyRunResponse({ step: 'claim', status: 200, body: JSON.stringify({ outcome }) })
          .outcome,
      ).toBe(EMPTY);
    }
    for (const outcome of ['claimed', 'mine']) {
      expect(
        classifyRunResponse({ step: 'claim', status: 200, body: JSON.stringify({ outcome }) })
          .outcome,
      ).toBe(OK);
    }
  });

  it('a RATE_LIMIT_EXCEEDED 429 is limited, with the body wait first and the header second', () => {
    const body = JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 7 });
    const v = classifyRunResponse({
      step: 'events',
      status: 429,
      headers: { 'Retry-After': '9' },
      body,
    });
    expect(v).toMatchObject({ outcome: LIMITED, retryAfterSeconds: 7 });
    expect(
      classifyRunResponse({ step: 'open', status: 429, headers: { 'retry-after': '9' } }),
    ).toMatchObject({ outcome: LIMITED, retryAfterSeconds: 9 });
  });

  it("each step's documented status is ok and anything else is an error", () => {
    expect(classifyRunResponse({ step: 'open', status: 201, body: '{}' }).outcome).toBe(OK);
    expect(classifyRunResponse({ step: 'open', status: 200, body: '{}' }).outcome).toBe(ERROR);
    expect(classifyRunResponse({ step: 'heartbeat', status: 204 }).outcome).toBe(OK);
    expect(classifyRunResponse({ step: 'heartbeat', status: 409 }).outcome).toBe(ERROR);
    expect(classifyRunResponse({ step: 'read', status: 500 }).outcome).toBe(ERROR);
  });

  it('tags every request role: run, and only ok reaches the duration trend', () => {
    const added: Record<string, Array<Record<string, string>>> = {
      steps: [],
      stepDuration: [],
      limited: [],
    };
    const m = (k: string) => ({
      add: (_v: number, tags: Record<string, string>) => added[k]!.push(tags),
    });
    const metrics = { steps: m('steps'), stepDuration: m('stepDuration'), limited: m('limited') };
    for (const outcome of OUTCOMES)
      recordRunStep(metrics, { step: 'events', outcome, durationMs: 5 });
    expect(added['steps']!.every((t) => t['role'] === ROLE_RUN)).toBe(true);
    expect(added['steps']!.map((t) => t['outcome'])).toEqual(['ok', 'empty', 'limited', 'error']);
    expect(added['stepDuration']).toHaveLength(1);
    expect(added['limited']).toHaveLength(1);
  });

  it('uses exactly the shared four outcome strings', () => {
    expect([...OUTCOMES]).toEqual(['ok', 'empty', 'limited', 'error']);
  });
});

// ── One iteration against the route handlers ────────────────────────────────

const BASE = 'http://localhost:3000';
type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** The route module and handler for each operation. */
async function handlerFor(op: string): Promise<Handler> {
  const def = seq.RUN_OPERATIONS[op as keyof typeof seq.RUN_OPERATIONS];
  const mod = (await (async (): Promise<unknown> => {
    switch (op) {
      case 'getMe':
        return import('@/app/api/v1/me/route');
      case 'listWorkspaces':
        return import('@/app/api/v1/workspaces/route');
      case 'getWorkItem':
      case 'updateWorkItem':
        return import('@/app/api/v1/work-items/[key]/route');
      case 'claimWorkItem':
        return import('@/app/api/v1/work-items/[key]/claim/route');
      case 'getWorkItemDispatchPrompt':
        return import('@/app/api/v1/work-items/[key]/dispatch-prompt/route');
      case 'listWorkItemDesigns':
        return import('@/app/api/v1/work-items/[key]/designs/route');
      case 'transitionWorkItem':
        return import('@/app/api/v1/work-items/[key]/transitions/route');
      case 'openDispatchRun':
        return import('@/app/api/v1/dispatch-runs/route');
      case 'heartbeatDispatchRun':
        return import('@/app/api/v1/dispatch-runs/[id]/heartbeat/route');
      case 'appendDispatchRunEvents':
        return import('@/app/api/v1/dispatch-runs/[id]/events/route');
      case 'closeDispatchRun':
        return import('@/app/api/v1/dispatch-runs/[id]/close/route');
      default:
        throw new Error(op);
    }
  })()) as Record<string, Handler>;
  return mod[def.method]!;
}

async function call(token: string, r: Req, id?: string) {
  const params = { ...r.params, ...(id ? { id } : {}) };
  const handler = await handlerFor(r.op);
  const res = await handler(
    new Request(`${BASE}${seq.pathFor(r.op, params)}`, {
      method: seq.RUN_OPERATIONS[r.op as keyof typeof seq.RUN_OPERATIONS].method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
    }),
    { params: Promise.resolve(params) },
  );
  const body = res.status === 204 ? '' : await res.text();
  return {
    status: res.status,
    body,
    verdict: classifyRunResponse({ step: r.step, status: res.status, headers: res.headers, body }),
  };
}

describe('one run iteration against the shipped routes', () => {
  type Seeded = Awaited<ReturnType<typeof seedTenants>>;
  let manifest: Seeded;

  beforeAll(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    manifest = await seedTenants(SMOKE_SHAPE, {
      runTag: 'runlife',
      databaseHost: 'localhost',
      log: () => {},
    });
  }, 300_000);

  afterAll(async () => {
    await truncateAuthTables();
  });

  it('opens, beats, reports and closes a no-push run, then recycles the card', async () => {
    const agent = manifest.agents.find((a) => a.role === 'run')!;
    const project = manifest.projects.find((p) => p.id === agent.projectId)!;
    const card = seq.runSlice(manifest, agent)[0]!;
    const plan = seq.planIteration({
      key: card.key,
      projectKey: project.key,
      agentSeconds: 60,
      recycle: true,
      logEventsPerBeat: 0,
      idempotencyKey: 'lt-1-0-test',
    });

    for (const r of plan.before as Req[]) {
      const { verdict, status } = await call(agent.token, r);
      expect([r.op, verdict.outcome, status]).toEqual([r.op, OK, 200]);
    }
    const opened = await call(agent.token, plan.open as Req);
    expect(opened.status).toBe(201);
    const runId = dispatchRunOpenedSchema.parse(JSON.parse(opened.body)).run.id;
    for (const r of plan.after as Req[]) {
      const { verdict, status } = await call(agent.token, r, runId);
      expect([r.op, verdict.outcome]).toEqual([r.op, OK]);
      if (r.op === 'heartbeatDispatchRun') expect(status).toBe(204);
    }

    const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('succeeded');
    expect(run.stopReason).toBe('completed');
    expect(run.lastHeartbeatAt).not.toBeNull();
    const events = await adminDb.dispatchRunEvent.findMany({
      where: { dispatchRunId: runId },
      orderBy: { seq: 'asc' },
      select: { kind: true },
    });
    const kinds = events.map((e) => e.kind);
    for (const k of [
      'run_opened',
      'checkout_ready',
      'prompt_issued',
      'agent_started',
      'agent_exited',
      'leg_verdict',
    ]) {
      expect(kinds).toContain(k);
    }
    expect(kinds.indexOf('run_opened')).toBeLessThan(kinds.indexOf('leg_verdict'));
    expect(kinds).not.toContain('delivery_linked');
    expect(kinds).not.toContain('ci_verdict');
    // The story gate (MOTIR-8681): a load-test run leaves no pull request and no
    // container behind it.
    expect(await adminDb.githubPullRequest.count()).toBe(0);
    expect(await adminDb.ciContainerUsage.count()).toBe(0);
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);

    const item = await adminDb.workItem.findFirstOrThrow({
      where: { id: card.id },
      select: { status: true, assigneeId: true },
    });
    expect(item.assigneeId).toBeNull();
    expect(item.status).toBe('todo');
  }, 120_000);

  it('a card someone else holds answers the claim taken: empty, and no run opens', async () => {
    const first = manifest.agents.find((a) => a.role === 'run')!;
    const card = seq.runSlice(manifest, first)[0]!;
    const claim = { op: 'claimWorkItem', step: 'claim', params: { key: card.key } };
    expect((await call(first.token, claim)).verdict.outcome).toBe(OK);
    const runsBefore = await adminDb.dispatchRun.count();
    // A member of the same project, signed in as another user.
    const other = manifest.agents.find(
      (a) => a.role === 'run' && a.projectId === first.projectId && a.userId !== first.userId,
    )!;
    expect(other).toBeDefined();
    const refused = await call(other.token, claim);
    expect(refused.verdict.outcome).toBe(EMPTY);
    expect(await adminDb.dispatchRun.count()).toBe(runsBefore);
  }, 60_000);
});
