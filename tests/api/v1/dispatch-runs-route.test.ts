import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import {
  dispatchRunAppendedSchema,
  dispatchRunOpenedSchema,
  dispatchRunSchema,
} from '@/lib/api/v1/workLoop/schema';
import { DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The DISPATCH RUN ingest routes (Story MOTIR-1789 · MOTIR-1792) — open, append,
// close — against real Postgres.
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. The lifecycle itself — the SET,
// the seq, the lock, the real-concurrency close — is asserted one layer down in
// `tests/dispatchRunService.test.ts`, against the service that owns it. This
// file asserts the things only the ROUTE can be wrong about:
//
//   1. every response PARSES against its declared schema, so a mapper that
//      drifts from the published contract fails before a client sees it;
//   2. every domain error reaches the wrapper and comes back as the STATUS
//      `DOMAIN_ERROR_STATUS` promises. An unproven row in that map is
//      indistinguishable from a missing one, and a missing one is a silent 500 —
//      so each of the six is driven here by a REAL service error;
//   3. the permission each route declares is the one the operation declares;
//   4. a run in ANOTHER workspace is a 404 and never a 403.

const BASE = 'http://localhost:3000/api/v1';

function request(path: string, caller: V1ProjectCaller, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...caller.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function openRun(caller: V1ProjectCaller, body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/route');
  return POST(request('/dispatch-runs', caller, body), { params: Promise.resolve({}) });
}

async function appendEvents(caller: V1ProjectCaller, id: string, body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/events/route');
  return POST(request(`/dispatch-runs/${id}/events`, caller, body), {
    params: Promise.resolve({ id }),
  });
}

async function closeRun(caller: V1ProjectCaller, id: string, body: unknown): Promise<Response> {
  const { POST } = await import('@/app/api/v1/dispatch-runs/[id]/close/route');
  return POST(request(`/dispatch-runs/${id}/close`, caller, body), {
    params: Promise.resolve({ id }),
  });
}

async function seedCard(caller: V1ProjectCaller, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.fixture.ctx,
  );
  return item.identifier;
}

/** Open a run over one fresh card and return `{ id, key }`. */
async function seedRun(caller: V1ProjectCaller): Promise<{ id: string; key: string }> {
  const key = await seedCard(caller, 'a card the run owns');
  const res = await openRun(caller, {
    projectKey: caller.projectKey,
    command: 'run_scope',
    cards: [{ key, disposition: 'queued' }],
  });
  expect(res.status, 'seeding a run').toBe(201);
  const parsed = dispatchRunOpenedSchema.parse(await res.json());
  return { id: parsed.run.id, key };
}

describe('the dispatch-run ingest routes', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  it('opens a run with its SET, and the body parses against the declared schema', async () => {
    const worked = await seedCard(caller, 'a card to work');
    const skipped = await seedCard(caller, 'a card to skip');

    const res = await openRun(caller, {
      projectKey: caller.projectKey,
      command: 'batch',
      agent: 'claude',
      model: 'claude-opus-5',
      cards: [
        { key: worked, disposition: 'queued' },
        { key: skipped, disposition: 'skipped', skipReason: 'needs_human' },
      ],
    });

    expect(res.status).toBe(201);
    const parsed = dispatchRunOpenedSchema.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    expect(parsed.data?.created).toBe(true);
    expect(parsed.data?.run.cards.map((c) => [c.position, c.key, c.disposition])).toEqual([
      [0, worked, 'queued'],
      [1, skipped, 'skipped'],
    ]);
    expect(parsed.data?.run.cards[1]?.skipReason).toBe('needs_human');
  });

  it('appends and closes, and BOTH bodies parse against their declared schemas', async () => {
    const { id, key } = await seedRun(caller);

    const appended = await appendEvents(caller, id, {
      events: [
        { kind: 'run_opened', data: { command: 'run_scope' } },
        { kind: 'card_claimed', workItemKey: key, disposition: 'running' },
      ],
    });
    expect(appended.status).toBe(200);
    const appendedBody = dispatchRunAppendedSchema.safeParse(await appended.json());
    expect(appendedBody.success, JSON.stringify(appendedBody.error?.issues, null, 2)).toBe(true);
    expect(appendedBody.data?.appended).toBe(2);
    expect(appendedBody.data?.seq).toBe(2);
    expect(appendedBody.data?.cards).toHaveLength(1);

    const closed = await closeRun(caller, id, { stopReason: 'completed' });
    expect(closed.status).toBe(200);
    const closedBody = dispatchRunSchema.safeParse(await closed.json());
    expect(closedBody.success, JSON.stringify(closedBody.error?.issues, null, 2)).toBe(true);
    expect(closedBody.data?.status).toBe('succeeded');
    expect(closedBody.data?.stopReason).toBe('completed');
    expect(closedBody.data?.seq).toBe(2);
  });

  it('returns 201 with `created: false` on the IDEMPOTENT repeat', async () => {
    const key = await seedCard(caller, 'the only card');
    const body = {
      projectKey: caller.projectKey,
      command: 'auto',
      idempotencyKey: 'route-idem-1',
      cards: [{ key, disposition: 'queued' }],
    };

    const first = dispatchRunOpenedSchema.parse(await (await openRun(caller, body)).json());
    const second = await openRun(caller, body);

    // ⚠️ 201 ON THE REPEAT TOO, deliberately. The caller holds the run it asked
    // for either way; `created` is the field that says which happened, and
    // splitting the status would make every caller branch on a code to learn
    // something the body already tells them.
    expect(second.status).toBe(201);
    const parsed = dispatchRunOpenedSchema.parse(await second.json());
    expect(parsed.created).toBe(false);
    expect(parsed.run.id).toBe(first.run.id);
  });

  // ── Every DOMAIN_ERROR_STATUS row, driven by a REAL service error ─────────

  it('404 — DISPATCH_RUN_NOT_FOUND for a run that does not exist', async () => {
    const res = await appendEvents(caller, 'cmnotarealrunid00000000', {
      events: [{ kind: 'log', body: 'x' }],
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_NOT_FOUND' });
  });

  it('404 — a run in ANOTHER workspace, never a 403', async () => {
    const { id } = await seedRun(caller);
    const other = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      workspaceName: 'Other',
      identifier: 'OTHR',
    });

    const res = await appendEvents(other, id, { events: [{ kind: 'log', body: 'x' }] });
    // ⚠️ INDISTINGUISHABLE from a run that never existed. A 403 would confirm
    // the run EXISTS — an existence oracle over another tenant's data (ADR §4) —
    // and here it falls out of the RLS gate rather than being re-implemented.
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_NOT_FOUND' });
  });

  it('409 — DISPATCH_RUN_TERMINAL on an append to a closed run', async () => {
    const { id } = await seedRun(caller);
    expect((await closeRun(caller, id, { stopReason: 'completed' })).status).toBe(200);

    const res = await appendEvents(caller, id, { events: [{ kind: 'log', body: 'late' }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_TERMINAL' });
  });

  it('409 — DISPATCH_RUN_TERMINAL on a second close', async () => {
    const { id } = await seedRun(caller);
    expect((await closeRun(caller, id, { stopReason: 'drained' })).status).toBe(200);

    const res = await closeRun(caller, id, { stopReason: 'halted' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_TERMINAL' });
  });

  it('409 — DUPLICATE_DISPATCH_RUN when two opens race one idempotency key', async () => {
    const key = await seedCard(caller, 'the raced card');
    const body = {
      projectKey: caller.projectKey,
      command: 'auto',
      idempotencyKey: 'route-raced',
      cards: [{ key, disposition: 'queued' }],
    };

    // Genuinely concurrent. The loser may also lose the READ race and come back
    // 201 with `created: false`, which is equally correct — so the assertion is
    // that a conflict, IF it happens, is the typed 409 and never a bare 500.
    const [a, b] = await Promise.all([openRun(caller, body), openRun(caller, body)]);
    for (const res of [a, b]) {
      expect([201, 409]).toContain(res.status);
      if (res.status === 409) {
        expect(await res.json()).toMatchObject({ code: 'DUPLICATE_DISPATCH_RUN' });
      }
    }
  });

  it('422 — UNKNOWN_DISPATCH_RUN_CARD for an event naming a card the run does not own', async () => {
    const { id } = await seedRun(caller);
    const outsider = await seedCard(caller, 'not in the set');

    const res = await appendEvents(caller, id, {
      events: [{ kind: 'card_claimed', workItemKey: outsider }],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'UNKNOWN_DISPATCH_RUN_CARD' });
  });

  it('413 — DISPATCH_RUN_BODY_TOO_LARGE, refused rather than truncated', async () => {
    const { id } = await seedRun(caller);

    const res = await appendEvents(caller, id, {
      events: [{ kind: 'log', body: 'x'.repeat(DISPATCH_RUN_EVENT_BODY_LIMIT_BYTES + 1) }],
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'DISPATCH_RUN_BODY_TOO_LARGE' });
  });

  it('422 — a malformed body, including the skip-reason pairing', async () => {
    const key = await seedCard(caller, 'a card');

    // The pairing is refused at the EDGE, in both directions, mirroring the
    // database's own CHECK constraint rather than restating a convention.
    const missingReason = await openRun(caller, {
      projectKey: caller.projectKey,
      command: 'batch',
      cards: [{ key, disposition: 'skipped' }],
    });
    expect(missingReason.status).toBe(422);
    expect(await missingReason.json()).toMatchObject({ code: 'INVALID_BODY' });

    const reasonWithoutSkip = await openRun(caller, {
      projectKey: caller.projectKey,
      command: 'batch',
      cards: [{ key, disposition: 'queued', skipReason: 'needs_human' }],
    });
    expect(reasonWithoutSkip.status).toBe(422);
    expect(await reasonWithoutSkip.json()).toMatchObject({ code: 'INVALID_BODY' });
  });

  it('404 — a project key this token cannot reach', async () => {
    const res = await openRun(caller, {
      projectKey: 'NOSUCH',
      command: 'next',
      cards: [],
    });
    expect(res.status).toBe(404);
  });

  // ── The declarations ──────────────────────────────────────────────────────

  it('each route declares the permission its operation declares', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/dispatch-runs'],
      ['POST', '/api/v1/dispatch-runs/{id}/events'],
      ['POST', '/api/v1/dispatch-runs/{id}/close'],
    ] as const) {
      const operation = findV1Operation(method, path);
      expect(operation, `${method} ${path} is declared`).toBeDefined();
      // `work_item:edit`, the key every other work-loop WRITE asserts. The
      // ingest invents no permission of its own — a run report is a write about
      // work items, made by the same credential that claims them.
      expect(operation?.permission).toBe('work_item:edit');
    }
  });

  it('401 without a token, on every one of the three', async () => {
    const anonymous = { headers: {} } as V1ProjectCaller;
    const { id } = await seedRun(caller);

    for (const res of [
      await openRun(anonymous, { projectKey: caller.projectKey, command: 'next', cards: [] }),
      await appendEvents(anonymous, id, { events: [{ kind: 'log' }] }),
      await closeRun(anonymous, id, { stopReason: 'completed' }),
    ]) {
      expect(res.status).toBe(401);
    }
  });
});
