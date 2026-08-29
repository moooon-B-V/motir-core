import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// The DISPATCH RUN READ routes (Story MOTIR-1789 · MOTIR-1793) — the browser's
// half of the seam, against real Postgres.
//
// Only the cookie-context resolver is stubbed (the test environment has no
// cookies); every gate, every service and every query beneath runs for real.
//
// ⚠️ THE STREAM IS DRIVEN AS A STREAM, not as a function. Its contract is the
// RESUME CURSOR — drop at `seq` N, reconnect with `since=N`, and receive neither
// a gap nor a duplicate — and a test that only called the service could not tell
// a correct cursor from an off-by-one, because both would return rows.

const workspaceCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => workspaceCtx.current };
});

const { GET: getRun } = await import('@/app/api/dispatch-runs/[id]/route');
const { GET: getStream } = await import('@/app/api/dispatch-runs/[id]/stream/route');
const { GET: getCardHistory } = await import('@/app/api/work-items/[key]/dispatch-runs/route');
const { GET: getActive } = await import('@/app/api/projects/[key]/dispatch-runs/active/route');
const { GET: getHistory } = await import('@/app/api/projects/[key]/dispatch-runs/route');
const { dispatchRunService } = await import('@/lib/services/dispatchRunService');
const { workItemsService } = await import('@/lib/services/workItemsService');

const BASE = 'http://localhost:3000';

let fixture: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
  workspaceCtx.current = { userId: fixture.ownerId, workspaceId: fixture.workspaceId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCards(count: number): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const item = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'task', title: `card ${i + 1}` },
      fixture.ctx,
    );
    keys.push(item.identifier);
  }
  return keys;
}

async function openRun(keys: string[], command: 'run_scope' | 'auto' | 'batch' = 'run_scope') {
  const { run } = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command,
      cards: keys.map((key) => ({ key, disposition: 'queued' as const })),
    },
    fixture.ctx,
  );
  return run;
}

function req(path: string): Request {
  return new Request(`${BASE}${path}`);
}

/** Read a whole SSE response body into its parsed frames. */
async function readFrames(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await res.text();
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event && data) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
}

describe('GET /api/dispatch-runs/[id]', () => {
  it('returns the header and the legs in STORED position order', async () => {
    const [a, b, c] = await seedCards(3);
    const run = await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'batch',
        scopeLabel: 'the active sprint',
        cards: [
          { key: c!, disposition: 'queued' },
          { key: a!, disposition: 'skipped', skipReason: 'needs_human' },
          { key: b!, disposition: 'queued' },
        ],
      },
      fixture.ctx,
    );

    const res = await getRun(req(`/api/dispatch-runs/${run.run.id}`), {
      params: Promise.resolve({ id: run.run.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      command: string;
      scopeLabel: string | null;
      cards: Array<{
        position: number;
        key: string;
        disposition: string;
        skipReason: string | null;
        deliveries: unknown[];
      }>;
    };

    expect(body.command).toBe('batch');
    expect(body.scopeLabel).toBe('the active sprint');
    // The run's OWN order — c, a, b — not key order and not creation order.
    expect(body.cards.map((card) => [card.position, card.key])).toEqual([
      [0, c],
      [1, a],
      [2, b],
    ]);
    expect(body.cards[1]!.skipReason).toBe('needs_human');
    // The delivery set is JOINED, and empty is the ordinary answer: nothing has
    // shipped for these cards. It is an ARRAY, never absent.
    expect(body.cards.every((card) => Array.isArray(card.deliveries))).toBe(true);
  });

  it('serializes a leg whose work item was DELETED', async () => {
    const [a] = await seedCards(1);
    const run = await openRun([a!]);
    await adminDb.workItem.deleteMany({ where: { identifier: a! } });

    const res = await getRun(req(`/api/dispatch-runs/${run.id}`), {
      params: Promise.resolve({ id: run.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cards: Array<{ key: string | null; workItemId: string | null; deliveries: unknown[] }>;
    };
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]!.workItemId).toBeNull();
    // The KEY survives, which is the whole reason it is stored on the leg.
    expect(body.cards[0]!.key).toBe(a);
    expect(body.cards[0]!.deliveries).toEqual([]);
  });

  it('401 without a session, 404 for a run in another workspace', async () => {
    const [a] = await seedCards(1);
    const run = await openRun([a!]);

    workspaceCtx.current = null;
    const anonymous = await getRun(req(`/api/dispatch-runs/${run.id}`), {
      params: Promise.resolve({ id: run.id }),
    });
    expect(anonymous.status).toBe(401);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    workspaceCtx.current = { userId: other.ownerId, workspaceId: other.workspaceId };
    const crossTenant = await getRun(req(`/api/dispatch-runs/${run.id}`), {
      params: Promise.resolve({ id: run.id }),
    });
    // ⚠️ 404, NEVER 403 — a 403 would confirm the run EXISTS, an existence
    // oracle over another tenant's data.
    expect(crossTenant.status).toBe(404);
  });
});

describe('GET /api/dispatch-runs/[id]/stream', () => {
  it('replays a TERMINAL run from the cursor and closes rather than holding the connection', async () => {
    const [a] = await seedCards(1);
    const run = await openRun([a!]);
    await dispatchRunService.appendEvents(
      run.id,
      [
        { kind: 'run_opened' },
        { kind: 'card_claimed', workItemKey: a!, disposition: 'running' },
        { kind: 'card_settled', workItemKey: a!, disposition: 'implemented' },
      ],
      fixture.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fixture.ctx);

    const res = await getStream(req(`/api/dispatch-runs/${run.id}/stream`), {
      params: Promise.resolve({ id: run.id }),
    });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');

    // It TERMINATES — `res.text()` returning at all is the assertion. A stream
    // that held the connection open on a finished run would hang here.
    const frames = await readFrames(res);
    expect(frames.map((f) => f.event)).toEqual(['event', 'event', 'event', 'done']);
    expect((frames[0]!.data as { seq: number }).seq).toBe(1);
    expect(frames[3]!.data).toMatchObject({ status: 'succeeded', seq: 3 });
  });

  it('RESUMES from `?since=<seq>` with no gap and no duplicate', async () => {
    const [a] = await seedCards(1);
    const run = await openRun([a!]);
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'run_opened' }, { kind: 'card_claimed', workItemKey: a! }],
      fixture.ctx,
    );

    // The first client drops after seq 2 — which it learns from the frames it
    // received, not from a separate call.
    const first = await getStream(req(`/api/dispatch-runs/${run.id}/stream?since=0`), {
      params: Promise.resolve({ id: run.id }),
    });
    // Cancel rather than read to the end: the run is still `running`, so the
    // stream would poll for ever. This IS the disconnect the resume exists for.
    await first.body!.cancel();

    await dispatchRunService.appendEvents(
      run.id,
      [
        { kind: 'agent_started', workItemKey: a! },
        { kind: 'agent_exited', workItemKey: a! },
      ],
      fixture.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fixture.ctx);

    const resumed = await getStream(req(`/api/dispatch-runs/${run.id}/stream?since=2`), {
      params: Promise.resolve({ id: run.id }),
    });
    const frames = await readFrames(resumed);
    const seqs = frames
      .filter((f) => f.event === 'event')
      .map((f) => (f.data as { seq: number }).seq);

    // ⚠️ EXACTLY 3 AND 4. No 1 or 2 (a duplicate — the client already has them),
    // and no missing 3 (a gap — the two events that landed while it was away).
    // This is what `@@unique([dispatchRunId, seq])` is for.
    expect(seqs).toEqual([3, 4]);
    expect(frames.at(-1)?.event).toBe('done');
  });

  it('treats a missing or nonsense cursor as "from the beginning"', async () => {
    const [a] = await seedCards(1);
    const run = await openRun([a!]);
    await dispatchRunService.appendEvents(run.id, [{ kind: 'run_opened' }], fixture.ctx);
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fixture.ctx);

    for (const query of ['', '?since=', '?since=-4', '?since=banana']) {
      const res = await getStream(req(`/api/dispatch-runs/${run.id}/stream${query}`), {
        params: Promise.resolve({ id: run.id }),
      });
      const seqs = (await readFrames(res))
        .filter((f) => f.event === 'event')
        .map((f) => (f.data as { seq: number }).seq);
      expect(seqs, `cursor "${query}"`).toEqual([1]);
    }
  });

  it('404s before the stream opens for a run in another workspace', async () => {
    const [a] = await seedCards(1);
    const run = await openRun([a!]);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    workspaceCtx.current = { userId: other.ownerId, workspaceId: other.workspaceId };

    const res = await getStream(req(`/api/dispatch-runs/${run.id}/stream`), {
      params: Promise.resolve({ id: run.id }),
    });
    // ⚠️ A REAL STATUS, not a stream that opens and immediately errors. The gate
    // runs BEFORE the first frame — the shipped route's ordering.
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).not.toBe('text/event-stream; charset=utf-8');
  });
});

describe('GET /api/work-items/[key]/dispatch-runs', () => {
  it('returns every run that carried a LEG for the card — including one it is not the scope of', async () => {
    const [swept, other] = await seedCards(2);
    const scope = await workItemsService.createWorkItem(
      { projectId: fixture.projectId, kind: 'story', title: 'the scope' },
      fixture.ctx,
    );

    // A SCOPED run over both cards, named for the story. The card was swept up;
    // it is not the scope, and no run ever named it.
    await dispatchRunService.open(
      {
        projectKey: fixture.projectIdentifier,
        command: 'run_scope',
        scopeKey: scope.identifier,
        cards: [
          { key: swept!, disposition: 'queued' },
          { key: other!, disposition: 'queued' },
        ],
      },
      fixture.ctx,
    );

    const res = await getCardHistory(req(`/api/work-items/${swept}/dispatch-runs`), {
      params: Promise.resolve({ key: swept! }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ id: string; command: string }> };
    // ⚠️ THE QUESTION IS "carried a leg", not "named it". The sprint run that
    // swept a card up is exactly the run its owner goes looking for.
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]!.command).toBe('run_scope');
  });

  it('is newest-first and cursor-paginated, so the CURRENT run is the first row', async () => {
    const [a] = await seedCards(1);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await openRun([a!], 'auto');
      await adminDb.dispatchRun.update({
        where: { id: run.id },
        data: { startedAt: new Date(Date.UTC(2026, 7, 20 + i)) },
      });
      ids.push(run.id);
    }

    const page1 = await getCardHistory(req(`/api/work-items/${a}/dispatch-runs?limit=2`), {
      params: Promise.resolve({ key: a! }),
    });
    const body1 = (await page1.json()) as {
      runs: Array<{ id: string }>;
      nextCursor: string | null;
    };
    // Newest first — the LAST run opened. That is what makes the item page's run
    // section need no second "current run" endpoint.
    expect(body1.runs.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect(body1.nextCursor).toBe(ids[1]);

    const page2 = await getCardHistory(
      req(`/api/work-items/${a}/dispatch-runs?limit=2&cursor=${body1.nextCursor}`),
      { params: Promise.resolve({ key: a! }) },
    );
    const body2 = (await page2.json()) as {
      runs: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(body2.runs.map((r) => r.id)).toEqual([ids[0]]);
    expect(body2.nextCursor).toBeNull();
  });

  it('404s for a card in another workspace', async () => {
    const [a] = await seedCards(1);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    workspaceCtx.current = { userId: other.ownerId, workspaceId: other.workspaceId };

    const res = await getCardHistory(req(`/api/work-items/${a}/dispatch-runs`), {
      params: Promise.resolve({ key: a! }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/[key]/dispatch-runs/active', () => {
  it('returns EVERY live run with its legs, in ONE request', async () => {
    const keys = await seedCards(5);
    const live1 = await openRun([keys[0]!, keys[1]!]);
    const live2 = await openRun([keys[2]!], 'auto');
    const finished = await openRun([keys[3]!], 'batch');
    await dispatchRunService.close(finished.id, { stopReason: 'completed' }, fixture.ctx);
    await dispatchRunService.appendEvents(
      live1.id,
      [{ kind: 'card_claimed', workItemKey: keys[0]!, disposition: 'running' }],
      fixture.ctx,
    );

    const res = await getActive(
      req(`/api/projects/${fixture.projectIdentifier}/dispatch-runs/active`),
      { params: Promise.resolve({ key: fixture.projectIdentifier }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{ id: string; cards: Array<{ key: string; disposition: string }> }>;
    };

    // ⚠️ ONE REQUEST FOR THE WHOLE LIST. A per-card "is there a live run?"
    // endpoint would be one request per ready row on `/ready` — the N+1 this
    // shape exists to refuse, and the kind that looks fine with three rows.
    expect(body.runs.map((r) => r.id).sort()).toEqual([live1.id, live2.id].sort());
    // The CLOSED run is not live and does not appear.
    expect(body.runs.map((r) => r.id)).not.toContain(finished.id);

    const strip = body.runs.find((r) => r.id === live1.id)!;
    expect(strip.cards.map((c) => [c.key, c.disposition])).toEqual([
      [keys[0], 'running'],
      [keys[1], 'queued'],
    ]);
  });

  it('401 without a session; 404 for a project in another workspace', async () => {
    workspaceCtx.current = null;
    const anonymous = await getActive(
      req(`/api/projects/${fixture.projectIdentifier}/dispatch-runs/active`),
      { params: Promise.resolve({ key: fixture.projectIdentifier }) },
    );
    expect(anonymous.status).toBe(401);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    workspaceCtx.current = { userId: other.ownerId, workspaceId: other.workspaceId };
    const crossTenant = await getActive(
      req(`/api/projects/${fixture.projectIdentifier}/dispatch-runs/active`),
      { params: Promise.resolve({ key: fixture.projectIdentifier }) },
    );
    expect(crossTenant.status).toBe(404);
  });
});

// ── GET /api/projects/[key]/dispatch-runs (MOTIR-3922) ──────────────────────
// The RUNS INDEX's read. The service half is covered in
// `tests/dispatchRunProjectHistory.test.ts` — the narrowings, the cursor, the
// leg counts and the tenancy binding. What is asserted HERE is what only the
// route owns: the session gate, the query-string parsing, and the cursor it
// hands back.

describe('GET /api/projects/[key]/dispatch-runs', () => {
  const path = (qs = '') =>
    `/api/projects/${fixture.projectIdentifier}/dispatch-runs${qs ? `?${qs}` : ''}`;
  const params = () => ({ params: Promise.resolve({ key: fixture.projectIdentifier }) });

  it('returns the page and a nextCursor only while there is another page', async () => {
    const keys = await seedCards(2);
    const opened: string[] = [];
    for (let i = 0; i < 3; i += 1) opened.push((await openRun([keys[0]!, keys[1]!])).id);

    const first = await getHistory(req(path('limit=2')), params());
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      runs: Array<{ id: string; cardCount: number; legs: Record<string, number> }>;
      nextCursor: string | null;
    };
    expect(page1.runs).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.runs[1]!.id);
    // The row carries its set as COUNTS and no leg array at all.
    expect(page1.runs[0]).toMatchObject({ cardCount: 2 });
    expect(page1.runs[0]!.legs.queued).toBe(2);
    expect(page1.runs[0]).not.toHaveProperty('cards');

    const second = await getHistory(req(path(`limit=2&cursor=${page1.nextCursor}`)), params());
    const page2 = (await second.json()) as {
      runs: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page2.runs).toHaveLength(1);
    // A short page is the LAST page, so the cursor is null rather than an id
    // that would walk a client into an empty request.
    expect(page2.nextCursor).toBeNull();
    expect([...page1.runs, ...page2.runs].map((r) => r.id).sort()).toEqual([...opened].sort());
  });

  it('narrows on ?status=live / past, and 400s on a status it does not know', async () => {
    const keys = await seedCards(1);
    const live = await openRun([keys[0]!]);
    const done = await openRun([keys[0]!], 'batch');
    await dispatchRunService.close(done.id, { stopReason: 'completed' }, fixture.ctx);

    const liveRes = await getHistory(req(path('status=live')), params());
    expect(
      ((await liveRes.json()) as { runs: Array<{ id: string }> }).runs.map((r) => r.id),
    ).toEqual([live.id]);
    const pastRes = await getHistory(req(path('status=past')), params());
    expect(
      ((await pastRes.json()) as { runs: Array<{ id: string }> }).runs.map((r) => r.id),
    ).toEqual([done.id]);
    const rawRes = await getHistory(req(path('status=succeeded')), params());
    expect(
      ((await rawRes.json()) as { runs: Array<{ id: string }> }).runs.map((r) => r.id),
    ).toEqual([done.id]);

    // ⚠️ A MISTYPED FILTER IS A 400, NOT THE WHOLE LIST. Returning everything
    // would tell a client its filter worked.
    const bad = await getHistory(req(path('status=finished')), params());
    expect(bad.status).toBe(400);
  });

  it('404s for an unresolvable ?scope, and 401 without a session', async () => {
    const missing = await getHistory(req(path('scope=PROD-999999')), params());
    expect(missing.status).toBe(404);

    workspaceCtx.current = null;
    expect((await getHistory(req(path()), params())).status).toBe(401);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    workspaceCtx.current = { userId: other.ownerId, workspaceId: other.workspaceId };
    expect((await getHistory(req(path()), params())).status).toBe(404);
  });
});
