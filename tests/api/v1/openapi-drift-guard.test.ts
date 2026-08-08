import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// motir-ai is STUBBED, and only motir-ai. Story 11.7's expansion submit is the
// one operation in the registry that reaches outside this process, and the
// alternative to a stub is an `UNDRIVABLE` excuse — i.e. a declared operation
// whose real response nothing validates, which is precisely the hole this suite
// exists to close. The stub replaces the network hop and nothing else: the
// route, the service, the Plan row it opens and the response it shapes are all
// real, against real Postgres.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(async () => ({ jobId: 'job_drift_guard' })),
}));
import { z } from 'zod/v4';
import { V1_OPERATIONS, findV1Operation } from '@/lib/api/v1/openapi/registry';
import { defineOperation, operationKey, type V1Operation } from '@/lib/api/v1/openapi/operation';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { v1RouteFiles } from '../../helpers/v1RouteAudit';
import {
  findSpecDrift,
  responseSchemaFor,
  shippedRouteMethods,
  staleUndrivableEntries,
  syntheticRouteFile,
  unexercisedOperations,
} from '../../helpers/v1SpecConformance';

// The route↔spec CONFORMANCE GUARD (Story 11.4 · Subtask 11.4.6 — MOTIR-2187).
//
// Everything before this card produces a document that is correct TODAY. This
// is what stops it quietly becoming wrong, and it is the only deliverable in
// the story whose absence would not be noticed for months.
//
// Three drifts, each proven by DELIBERATELY INTRODUCING IT:
//
//   1. A `/api/v1` route with no operation — a "complete" reference that is
//      partial, undetectable from the document alone.
//   2. An operation naming no route — worse: a client builds against it and
//      gets a 404.
//   3. A REAL response that no longer validates against its declared schema —
//      the drift that makes the other two look fine.
//
// ⚠️ Drift 3 is driven against a REAL request and a REAL response through the
// shipped fixtures and real Postgres. Validating a fixture generated from the
// schema under test would test the fixture.
//
// ⚠️ NO SILENT CAPS. `UNDRIVABLE` below is the complete list of operations this
// suite does not exercise, each with a written reason, and
// `unexercisedOperations` FAILS on an operation that is neither driven nor
// excused. A quietly-skipped operation reads exactly like a covered one.

const REPO_ROOT = process.cwd();
const ORIGIN = 'http://localhost:3000';

/**
 * Operations this suite cannot drive in process, each with its reason.
 *
 * EMPTY, deliberately: every declared operation is reachable through the
 * shipped in-process harness. It exists as a named, asserted mechanism rather
 * than as a convention, so the day one genuinely cannot be driven the excuse
 * has to be written down instead of silently omitted.
 */
const UNDRIVABLE: Readonly<Record<string, string>> = {};

/** Every route file's source, keyed the way the drift rules expect. */
function realRouteSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of v1RouteFiles(REPO_ROOT)) {
    sources.set(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
  }
  return sources;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drifts 1 and 2 — the tree against the registry
// ─────────────────────────────────────────────────────────────────────────────

describe('the route tree and the document agree', () => {
  it('passes against the real tree and the real registry', () => {
    const drift = findSpecDrift(shippedRouteMethods(realRouteSources()), V1_OPERATIONS);
    expect(drift, JSON.stringify(drift, null, 2)).toEqual([]);
  });

  it('is not vacuous — the walk finds routes and the registry has operations', () => {
    // A rule run over two empty sets agrees perfectly and proves nothing.
    expect(shippedRouteMethods(realRouteSources()).length).toBeGreaterThan(15);
    expect(V1_OPERATIONS.length).toBeGreaterThan(15);
  });

  it('DRIFT 1 FAILS: a route with an exported handler and no operation', () => {
    const sources = realRouteSources();
    sources.set(
      syntheticRouteFile('widgets'),
      `export const GET = withV1Route({ scope: 'read' }, async () => {});`,
    );

    const drift = findSpecDrift(shippedRouteMethods(sources), V1_OPERATIONS);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.rule).toBe('route-without-operation');
    expect(drift[0]?.subject).toBe('GET /api/v1/widgets');
  });

  it('DRIFT 2 FAILS: an operation whose path matches no route file', () => {
    const orphan: V1Operation = defineOperation({
      method: 'GET',
      path: '/api/v1/widgets',
      operationId: 'listWidgets',
      summary: 'A resource that does not exist',
      description: 'Renamed or removed, and still advertised.',
      scope: 'read',
      parameters: [],
      response: { status: 200, body: { kind: 'empty' }, description: 'nothing' },
      errorStatuses: [],
    });

    const drift = findSpecDrift(shippedRouteMethods(realRouteSources()), [
      ...V1_OPERATIONS,
      orphan,
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0]?.rule).toBe('operation-without-route');
    expect(drift[0]?.subject).toBe('GET /api/v1/widgets');
    expect(drift[0]?.detail).toContain('listWidgets');
  });

  it('a SCOPE mismatch fails too — the document may not lie about a permission', () => {
    const real = findV1Operation('GET', '/api/v1/work-items/{key}');
    expect(real).toBeDefined();
    const widened: V1Operation = { ...real!, scope: 'work_items:write' };
    const operations = V1_OPERATIONS.map((op) => (op === real ? widened : op));

    const drift = findSpecDrift(shippedRouteMethods(realRouteSources()), operations);
    expect(drift.map((d) => d.rule)).toEqual(['scope-mismatch']);
    expect(drift[0]?.detail).toContain('work_items:write');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift 3 — a real response against its declared schema
// ─────────────────────────────────────────────────────────────────────────────

/** What one driven operation produced. */
interface Driven {
  operationId: string;
  status: number;
  body: unknown;
}

describe('every operation’s REAL response validates against its declared schema', () => {
  let caller: V1ProjectCaller;
  const driven = new Map<string, Driven>();

  /** Call a route handler the way Next.js does, and record what came back. */
  async function drive(
    operationId: string,
    load: () => Promise<Record<string, unknown>>,
    request: Request,
    params: Record<string, string> = {},
  ): Promise<Driven> {
    const operation = V1_OPERATIONS.find((op) => op.operationId === operationId);
    expect(operation, `no operation named ${operationId}`).toBeDefined();

    const mod = await load();
    const handler = mod[operation!.method] as (
      req: Request,
      args?: { params: Promise<Record<string, string>> },
    ) => Promise<Response>;
    const res = await handler(request, { params: Promise.resolve(params) });

    const status = res.status;
    const body: unknown = status === 204 ? undefined : await res.json();
    const record = { operationId, status, body };
    driven.set(operationId, record);
    return record;
  }

  function get(path: string): Request {
    return new Request(`${ORIGIN}${path}`, { headers: caller.headers });
  }

  function send(path: string, method: string, body?: unknown): Request {
    return new Request(`${ORIGIN}${path}`, {
      method,
      headers: { ...caller.headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** Create a work item through the REAL route, returning its key. */
  async function createItem(title: string): Promise<string> {
    const { POST } = await import('@/app/api/v1/projects/[projectKey]/work-items/route');
    const res = await POST(
      send(`/api/v1/projects/${caller.projectKey}/work-items`, 'POST', { kind: 'task', title }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(res.status, `seeding "${title}"`).toBe(201);
    return ((await res.json()) as { key: string }).key;
  }

  beforeAll(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write', 'work_items:archive', 'sprints:write', 'integration'],
    });
    const pk = caller.projectKey;

    // ── Identity + discovery ────────────────────────────────────────────────
    await drive('getMe', () => import('@/app/api/v1/me/route'), get('/api/v1/me'));
    await drive(
      'listWorkspaces',
      () => import('@/app/api/v1/workspaces/route'),
      get('/api/v1/workspaces'),
    );
    await drive(
      'listProjects',
      () => import('@/app/api/v1/projects/route'),
      get('/api/v1/projects'),
    );
    await drive(
      'getProject',
      () => import('@/app/api/v1/projects/[projectKey]/route'),
      get(`/api/v1/projects/${pk}`),
      { projectKey: pk },
    );

    // ── Work items ──────────────────────────────────────────────────────────
    // ⚠️ Seeded through the REAL create route, NOT `createTestWorkItem`. That
    // fixture writes a zero-padded `position` ("000001"), which is not a valid
    // fractional-index key, so the next TOP-LEVEL create in the same project
    // fails in `keyForAppend` with `invalid order key head: 0` and surfaces as a
    // bare 500. `scripts/plan-seed/seed.ts` already carries that warning in
    // prose; the fixture does not. Filed as MOTIR-2196 — this suite simply does
    // not depend on it.
    const created = await drive(
      'createWorkItem',
      () => import('@/app/api/v1/projects/[projectKey]/work-items/route'),
      send(`/api/v1/projects/${pk}/work-items`, 'POST', { kind: 'story', title: 'A story' }),
      { projectKey: pk },
    );
    const key = (created.body as { key: string }).key;
    // A second item, so the link endpoints have both endpoints to name.
    const otherKey = await createItem('Another');

    await drive(
      'listProjectWorkItems',
      () => import('@/app/api/v1/projects/[projectKey]/work-items/route'),
      get(`/api/v1/projects/${pk}/work-items`),
      { projectKey: pk },
    );
    // The COUNT, driven beside the collection it counts (ADR Amendment 14).
    await drive(
      'countProjectWorkItems',
      () => import('@/app/api/v1/projects/[projectKey]/work-items/count/route'),
      get(`/api/v1/projects/${pk}/work-items/count`),
      { projectKey: pk },
    );
    await drive(
      'getWorkItem',
      () => import('@/app/api/v1/work-items/[key]/route'),
      get(`/api/v1/work-items/${key}`),
      { key },
    );
    // The work-loop read (Story 11.7). Driven HERE, beside the detail read, so
    // the assembled prompt is validated against its declared schema on a real
    // item rather than on a fixture.
    await drive(
      'getWorkItemDispatchPrompt',
      () => import('@/app/api/v1/work-items/[key]/dispatch-prompt/route'),
      get(`/api/v1/work-items/${key}/dispatch-prompt`),
      { key },
    );
    await drive(
      'updateWorkItem',
      () => import('@/app/api/v1/work-items/[key]/route'),
      send(`/api/v1/work-items/${key}`, 'PATCH', { title: 'A story, renamed' }),
      { key },
    );
    await drive(
      'listWorkItemTransitions',
      () => import('@/app/api/v1/work-items/[key]/transitions/route'),
      get(`/api/v1/work-items/${key}/transitions`),
      { key },
    );
    await drive(
      'transitionWorkItem',
      () => import('@/app/api/v1/work-items/[key]/transitions/route'),
      send(`/api/v1/work-items/${key}/transitions`, 'POST', { status: 'in_progress' }),
      { key },
    );
    await drive(
      'listWorkItemLinks',
      () => import('@/app/api/v1/work-items/[key]/links/route'),
      get(`/api/v1/work-items/${key}/links`),
      { key },
    );
    await drive(
      'createWorkItemLink',
      () => import('@/app/api/v1/work-items/[key]/links/route'),
      send(`/api/v1/work-items/${key}/links`, 'POST', {
        toKey: otherKey,
        relationship: 'relates_to',
      }),
      { key },
    );
    await drive(
      'deleteWorkItemLink',
      () => import('@/app/api/v1/work-items/[key]/links/route'),
      send(`/api/v1/work-items/${key}/links?toKey=${otherKey}&relationship=relates_to`, 'DELETE'),
      { key },
    );
    await drive(
      'createWorkItemComment',
      () => import('@/app/api/v1/work-items/[key]/comments/route'),
      send(`/api/v1/work-items/${key}/comments`, 'POST', { bodyMd: 'A comment.' }),
      { key },
    );
    await drive(
      'listWorkItemComments',
      () => import('@/app/api/v1/work-items/[key]/comments/route'),
      get(`/api/v1/work-items/${key}/comments`),
      { key },
    );

    // ── Planning ────────────────────────────────────────────────────────────
    await drive(
      'getProjectBacklog',
      () => import('@/app/api/v1/projects/[projectKey]/backlog/route'),
      get(`/api/v1/projects/${pk}/backlog`),
      { projectKey: pk },
    );
    await drive(
      'getProjectReadySet',
      () => import('@/app/api/v1/projects/[projectKey]/ready/route'),
      get(`/api/v1/projects/${pk}/ready`),
      { projectKey: pk },
    );
    await drive(
      'listProjectSprints',
      () => import('@/app/api/v1/projects/[projectKey]/sprints/route'),
      get(`/api/v1/projects/${pk}/sprints`),
      { projectKey: pk },
    );
    const sprint = await drive(
      'createSprint',
      () => import('@/app/api/v1/projects/[projectKey]/sprints/route'),
      send(`/api/v1/projects/${pk}/sprints`, 'POST', { name: 'Sprint 1' }),
      { projectKey: pk },
    );
    const sprintId = (sprint.body as { id: string }).id;

    await drive(
      'getSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/route'),
      get(`/api/v1/sprints/${sprintId}`),
      { sprintId },
    );
    await drive(
      'updateSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/route'),
      send(`/api/v1/sprints/${sprintId}`, 'PATCH', { goal: 'Ship the spec.' }),
      { sprintId },
    );
    await drive(
      'moveWorkItemsToSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/work-items/route'),
      send(`/api/v1/sprints/${sprintId}/work-items`, 'POST', { workItemKeys: [otherKey] }),
      { sprintId },
    );
    await drive(
      'listSprintWorkItems',
      () => import('@/app/api/v1/sprints/[sprintId]/work-items/route'),
      get(`/api/v1/sprints/${sprintId}/work-items`),
      { sprintId },
    );
    await drive(
      'moveWorkItemsToBacklog',
      () => import('@/app/api/v1/projects/[projectKey]/backlog/work-items/route'),
      send(`/api/v1/projects/${pk}/backlog/work-items`, 'POST', { workItemKeys: [otherKey] }),
      { projectKey: pk },
    );
    // Start before complete: `completeSprint` needs an ACTIVE sprint, and the
    // ordering is the real lifecycle rather than a test convenience.
    await drive(
      'startSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/start/route'),
      send(`/api/v1/sprints/${sprintId}/start`, 'POST', {}),
      { sprintId },
    );
    await drive(
      'completeSprint',
      () => import('@/app/api/v1/sprints/[sprintId]/complete/route'),
      send(`/api/v1/sprints/${sprintId}/complete`, 'POST', {}),
      { sprintId },
    );

    // ── Archive LAST, so every read above ran against a live item ───────────
    await drive(
      'archiveWorkItem',
      () => import('@/app/api/v1/work-items/[key]/archive/route'),
      send(`/api/v1/work-items/${key}/archive`, 'POST'),
      { key },
    );
    await drive(
      'restoreWorkItem',
      () => import('@/app/api/v1/work-items/[key]/restore/route'),
      send(`/api/v1/work-items/${key}/restore`, 'POST'),
      { key },
    );

    // ── Session close-out (Story 11.7) ──────────────────────────────────────
    // On a DEDICATED item, and last: `recordWorkItemIntegration` moves it to
    // `in_review` and `completeSession` then closes it, so driving them on the
    // item every other operation shares would change the state those drives
    // asserted against.
    const closing = await createItem('An item to integrate');
    {
      const { POST } = await import('@/app/api/v1/work-items/[key]/transitions/route');
      const res = await POST(
        send(`/api/v1/work-items/${closing}/transitions`, 'POST', { status: 'in_progress' }),
        { params: Promise.resolve({ key: closing }) },
      );
      expect(res.status, 'seeding the integration item').toBe(200);
    }
    await drive(
      'recordWorkItemIntegration',
      () => import('@/app/api/v1/work-items/[key]/integration/route'),
      send(`/api/v1/work-items/${closing}/integration`, 'POST', {
        sessionBranch: 'session/drift-guard',
      }),
      { key: closing },
    );
    await drive(
      'completeSession',
      () => import('@/app/api/v1/sessions/complete/route'),
      send('/api/v1/sessions/complete', 'POST', { sessionBranch: 'session/drift-guard' }),
    );

    // ── Expansion + the two plan reads (Story 11.7) ─────────────────────────
    // The submit is driven on the STORY (a container — a leaf cannot be
    // expanded) and its `planId` addresses both reads, so all three validate
    // against one real chain rather than three fixtures.
    const submitted = await drive(
      'submitWorkItemExpansion',
      () => import('@/app/api/v1/work-items/[key]/expansions/route'),
      send(`/api/v1/work-items/${key}/expansions`, 'POST'),
      { key },
    );
    const planId = (submitted.body as { planId: string }).planId;
    await drive(
      'getPlanStatus',
      () => import('@/app/api/v1/plans/[planId]/status/route'),
      get(`/api/v1/plans/${planId}/status`),
      { planId },
    );
    await drive(
      'getPlan',
      () => import('@/app/api/v1/plans/[planId]/route'),
      get(`/api/v1/plans/${planId}`),
      { planId },
    );

    // ── The planning conversation (Story 11.7) ──────────────────────────────
    // Ordered: open, append (a submit on an empty thread is refused), submit.
    await drive(
      'openPlanSession',
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/route'),
      send(`/api/v1/projects/${pk}/plan-session`, 'POST', {}),
      { projectKey: pk },
    );
    await drive(
      'appendPlanTurn',
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/turns/route'),
      send(`/api/v1/projects/${pk}/plan-session/turns`, 'POST', {
        body: 'keep every leaf under three points',
      }),
      { projectKey: pk },
    );
    await drive(
      'submitPlanSession',
      () => import('@/app/api/v1/projects/[projectKey]/plan-session/submissions/route'),
      send(`/api/v1/projects/${pk}/plan-session/submissions`, 'POST', {}),
      { projectKey: pk },
    );

    // ── The activity read (Story 11.7) ──────────────────────────────────────
    // Driven on the item that has BOTH a comment and a change trail by now, so
    // the `all` view's union validates against real entries of both types.
    await drive(
      'getWorkItemActivity',
      () => import('@/app/api/v1/work-items/[key]/activity/route'),
      get(`/api/v1/work-items/${key}/activity`),
      { key },
    );
  }, 120_000);

  it('every driven call SUCCEEDED at the status its operation declares', () => {
    // A 4xx would validate against nothing and make the schema checks below
    // vacuous, so the status is asserted before the shape.
    for (const [operationId, record] of driven) {
      const operation = V1_OPERATIONS.find((op) => op.operationId === operationId);
      expect(record.status, `${operationId} → ${JSON.stringify(record.body)}`).toBe(
        operation?.response.status,
      );
    }
  });

  it('DRIFT 3: every real response validates against its declared schema', () => {
    for (const [operationId, record] of driven) {
      const operation = V1_OPERATIONS.find((op) => op.operationId === operationId)!;
      const schema = responseSchemaFor(operation);
      if (schema === undefined) {
        // A 204 declares no body, so the assertion is that there ISN'T one.
        expect(record.body, `${operationId} declares no body`).toBeUndefined();
        continue;
      }
      const parsed = schema.safeParse(record.body);
      expect(
        parsed.success,
        `${operationId}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      ).toBe(true);
    }
  });

  it('DRIFT 3 FAILS: a declared schema mutated away from the real response', () => {
    // The negative proof. The response is the one the route really returned;
    // only the DECLARATION moves — which is exactly the drift this guards
    // against, since a schema is edited far more often than a route.
    const real = driven.get('getWorkItem');
    expect(real).toBeDefined();

    const mutated = defineOperation({
      ...findV1Operation('GET', '/api/v1/work-items/{key}')!,
      response: {
        status: 200,
        body: {
          kind: 'object',
          schema: workItemDetailSchema.extend({ estimatedVelocity: z.number() }),
        },
        description: 'drifted',
      },
    });

    const parsed = responseSchemaFor(mutated)!.safeParse(real!.body);
    expect(parsed.success).toBe(false);
    // Naming the offending field is the point: "the shape is wrong" sends the
    // next reader to diff two hundred lines by eye.
    expect(parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))).toContain(
      'estimatedVelocity',
    );
  });

  it('exercised EVERY operation, or excused it with a written reason', () => {
    const unexercised = unexercisedOperations(V1_OPERATIONS, new Set(driven.keys()), UNDRIVABLE);
    expect(unexercised, `operations neither driven nor excused: ${unexercised.join(', ')}`).toEqual(
      [],
    );
  });

  it('carries no STALE excuse for an operation that no longer exists', () => {
    expect(staleUndrivableEntries(V1_OPERATIONS, UNDRIVABLE)).toEqual([]);
  });

  it('would FAIL if an operation were silently skipped', () => {
    // The bookkeeping proven against a violation: drop one from the exercised
    // set with no excuse and the check must name it.
    const short = new Set(driven.keys());
    short.delete('getWorkItem');
    expect(unexercisedOperations(V1_OPERATIONS, short, UNDRIVABLE)).toEqual(['getWorkItem']);
    // …and an excuse with an EMPTY reason is not an excuse.
    expect(unexercisedOperations(V1_OPERATIONS, short, { getWorkItem: '   ' })).toEqual([
      'getWorkItem',
    ]);
    expect(
      unexercisedOperations(V1_OPERATIONS, short, { getWorkItem: 'needs a real browser' }),
    ).toEqual([]);
  });

  it('drove every operation the registry declares — no more, no less', () => {
    expect([...driven.keys()].sort()).toEqual(V1_OPERATIONS.map((op) => op.operationId).sort());
    expect(driven.size).toBe(new Set(V1_OPERATIONS.map(operationKey)).size);
  });
});
