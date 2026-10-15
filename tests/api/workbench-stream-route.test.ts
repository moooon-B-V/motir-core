import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// THE WORKBENCH STREAM (Story MOTIR-5238 · MOTIR-5241) — the browser's half of
// the live seam, against real Postgres. Only the cookie-context resolver is
// stubbed (the test environment has no cookies); every gate, service and query
// beneath runs for real, which is the shape `dispatchRunReadRoutes.test.ts` uses
// for the route this one mirrors.
//
// ⚠️ IT IS DRIVEN AS A STREAM, NOT AS A FUNCTION. Three of its four load-bearing
// properties are invisible to a caller that awaits the response body:
//
//   · THE GATE RUNS BEFORE THE STREAM OPENS, so a refusal is a real status with
//     a JSON body and NO frame — a stream that opened and then errored would
//     satisfy a test that only checked the status.
//   · A DISCONNECT ENDS THE SESSION. There is no terminal state here, so
//     `cancel()` is the only thing that ever ends this stream; a session that
//     ignores it stays subscribed and keeps re-reading the database for a reader
//     who has closed the tab, for ever, and nothing anywhere goes red.
//   · A WRITE IS HEARD BY PUSH. Since MOTIR-8729 nothing polls: a committed
//     write fires the live-signal trigger, the process's real listener hub hears
//     it, and the stream re-reads. These tests drive that whole path for real.
//   · REPLAYING A CURSOR IS HARMLESS. The cursor names a STATE rather than a
//     position, which is what replaces the run stream's
//     `@@unique([dispatchRunId, seq])`, and the only way to show it is to
//     connect twice with the same one.
//
// ⚠️ AND THE CONVENTION IS ASSERTED AGAINST THE SHIPPED ROUTE ITSELF, never
// against a literal copied out of it. A literal here would agree with the
// dispatch-run stream on the day it was typed and drift silently afterwards,
// which is the whole failure the one-convention rule exists to prevent.

const workspaceCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => workspaceCtx.current };
});

const { GET } = await import('@/app/api/workbench/stream/route');
const routeModule = await import('@/app/api/workbench/stream/route');
const {
  WORKBENCH_STREAM_BACKSTOP_MS,
  WORKBENCH_STREAM_COALESCE_MS,
  WORKBENCH_STREAM_HEARTBEAT_MS,
  WORKBENCH_STREAM_FRAME,
} = routeModule;
const { GET: getRunStream, DISPATCH_RUN_STREAM_HEARTBEAT_MS } =
  await import('@/app/api/dispatch-runs/[id]/stream/route');
const { getLiveSignalHub } = await import('@/lib/live/liveSignalHub');
const { dispatchRunService } = await import('@/lib/services/dispatchRunService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workbenchWatermarkService } = await import('@/lib/services/workbenchWatermarkService');

const BASE = 'http://localhost:3000';

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WST' });
  workspaceCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await getLiveSignalHub().stop();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `condition` holds, or fail naming what was awaited. */
async function until(condition: () => boolean, what: string, budgetMs = 8_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * Wait until the process's listener is LISTENING. A write that commits before
 * then is not lost — the connect's catch-up read picks it up — but waiting makes
 * each test exercise the path it names rather than the catch-up.
 */
async function listening(): Promise<void> {
  await until(() => getLiveSignalHub().connected, 'the live-signal listener to connect');
}

function req(path: string): Request {
  return new Request(`${BASE}${path}`);
}

async function card(title: string): Promise<{ id: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id };
}

interface Frame {
  event: string;
  data: { moved: string[]; cursor: string };
}

/**
 * Open the stream and read frames until `want` of them have arrived or the
 * budget runs out, then CANCEL — which is also how a browser leaves.
 *
 * A response body that never ends cannot be read with `res.text()`, and the
 * temptation to make it endable for the tests' sake is the temptation to test a
 * different route: not ending is this stream's contract.
 */
async function readFrames(
  res: Response,
  want: number,
  budgetMs = 8_000,
): Promise<{ frames: Frame[]; comments: number }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let comments = 0;
  let buffer = '';
  const deadline = Date.now() + budgetMs;
  try {
    while (frames.length < want && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done || !chunk.value) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (block.startsWith(':')) comments += 1;
        else {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel();
  }
  return { frames, comments };
}

describe('THE GATE RUNS BEFORE THE STREAM OPENS', () => {
  it('answers 401 with a JSON body and NO event stream when there is no session', async () => {
    workspaceCtx.current = null;

    const res = await GET(req('/api/workbench/stream'));

    expect(res.status).toBe(401);
    // ⚠️ THE CONTENT TYPE IS THE ASSERTION. A route that opened the stream and
    // then refused would return 200 and an `text/event-stream` body carrying an
    // error frame — which is a refusal a reader has already been handed a
    // connection for.
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('answers 404 with a JSON body when the reader has no active project', async () => {
    // ⚠️ THE RESOLVER IS STUBBED BECAUSE THE STATE IS UNREACHABLE, and that is
    // worth saying rather than working around. Emptying the workspace does NOT
    // produce it: `projectsService.getActiveProject` HEALS a workspace with no
    // project by seeding one (MOTIR-4870), so the only null left is a request
    // with no session, which the gate above has already answered. The branch
    // stays because the TYPE says null, and this is the honest way to exercise
    // it — the alternative is an uncovered guard whose behaviour nobody knows.
    vi.spyOn(projectsService, 'getActiveProject').mockResolvedValue(null);

    const res = await GET(req('/api/workbench/stream'));

    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
  });
});

describe('THE CONVENTION — asserted against the SHIPPED route, not against a literal', () => {
  it('returns the same SSE header set the dispatch-run stream returns', async () => {
    // The shipped route, driven for real: a TERMINAL run, so it replays and
    // closes rather than holding a connection open inside this test.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'A card to run' },
      fx.ctx,
    );
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        cards: [{ key: item.identifier, disposition: 'queued' as const }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'completed' }, fx.ctx);
    const shipped = await getRunStream(req(`/api/dispatch-runs/${run.id}/stream`), {
      params: Promise.resolve({ id: run.id }),
    });
    await shipped.text();

    const mine = await GET(req('/api/workbench/stream'));
    await mine.body!.cancel();

    for (const header of ['Content-Type', 'Cache-Control', 'Connection']) {
      expect(mine.headers.get(header), `header ${header}`).toBe(shipped.headers.get(header));
    }
  });

  it('heartbeats on the SAME interval the shipped route uses', () => {
    // Read from the shipped route's own exported constant. Two copies of
    // `15_000` agree today; these cannot disagree tomorrow without somebody
    // seeing it.
    expect(WORKBENCH_STREAM_HEARTBEAT_MS).toBe(DISPATCH_RUN_STREAM_HEARTBEAT_MS);
  });

  it('has no poll interval any more — only a coalescing window and a backstop (MOTIR-8729)', () => {
    expect('WORKBENCH_STREAM_POLL_MS' in routeModule).toBe(false);
    expect(WORKBENCH_STREAM_COALESCE_MS).toBe(250);
    expect(WORKBENCH_STREAM_BACKSTOP_MS).toBe(60_000);
  });
});

describe('THE FRAMES', () => {
  it('writes an OPENING frame carrying the cursor, even when nothing moved', async () => {
    const res = await GET(req('/api/workbench/stream'));
    const { frames } = await readFrames(res, 1, 3_000);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe(WORKBENCH_STREAM_FRAME);
    // ⚠️ `moved: []` AND A CURSOR. The empty list is the honest answer for a
    // reader who presented nothing; the cursor is why the frame is written at
    // all, because it is how the client learns what to present on a reconnect.
    expect(frames[0]!.data.moved).toEqual([]);
    expect(frames[0]!.data.cursor).toMatch(/^w1\./);
  });

  it('names the tabs that moved since a cursor the caller presents', async () => {
    const stale = (await workbenchWatermarkService.read({ ...fx.ctx, projectId: fx.projectId }))
      .cursor;
    await card('Filed while the reader was away');

    const res = await GET(req(`/api/workbench/stream?since=${encodeURIComponent(stale)}`));
    const { frames } = await readFrames(res, 1, 3_000);

    // Filing a card puts it in To do AND auto-watches it for the filer, so two
    // tabs move — which is the product's behaviour, not noise in the fixture.
    expect(frames[0]!.data.moved).toEqual(['toDo', 'watching']);
  });

  it('names EVERY tab for a cursor it cannot read — a reader on an older build', async () => {
    const res = await GET(req('/api/workbench/stream?since=w0.something-else'));
    const { frames } = await readFrames(res, 1, 3_000);

    expect(frames[0]!.data.moved).toEqual([
      'toDo',
      'inProgress',
      'toFix',
      'toResume',
      'recentlyFinished',
      'approvals',
      'watching',
    ]);
  });

  it('writes a frame when something moves WHILE the reader is connected', async () => {
    const res = await GET(req('/api/workbench/stream'));
    const reading = readFrames(res, 2, 8_000);
    await listening();
    await card('Arrived while they were looking');

    const { frames } = await reading;

    expect(frames).toHaveLength(2);
    expect(frames[0]!.data.moved).toEqual([]);
    expect(frames[1]!.data.moved).toContain('toDo');
    // The cursor MOVES with the frame, so the client's next reconnect resumes
    // from what it has just been told rather than from where it connected.
    expect(frames[1]!.data.cursor).not.toBe(frames[0]!.data.cursor);
  });

  it('carries no work-item content of any kind', async () => {
    await card('A very distinctive title');
    const res = await GET(req('/api/workbench/stream?since=w0.unreadable'));
    const { frames } = await readFrames(res, 1, 3_000);

    const serialised = JSON.stringify(frames[0]!.data);
    expect(serialised).not.toContain('A very distinctive title');
    expect(serialised).not.toContain(fx.projectId);
    expect(Object.keys(frames[0]!.data).sort()).toEqual(['cursor', 'moved']);
  });
});

describe('THE RESUME CONTRACT', () => {
  it('replaying the SAME cursor produces no work for the client, however many times', async () => {
    await card('Something to see');

    const first = await GET(req('/api/workbench/stream'));
    const opening = (await readFrames(first, 1, 3_000)).frames[0]!;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const again = await GET(
        req(`/api/workbench/stream?since=${encodeURIComponent(opening.data.cursor)}`),
      );
      const { frames } = await readFrames(again, 1, 3_000);
      // ⚠️ THE FRAME ARRIVES AND NAMES NOTHING, which is the whole of the
      // idempotence claim: a reconnect that missed nothing asks the client to
      // re-read nothing, and does it without the server remembering anything.
      expect(frames[0]!.data.moved, `attempt ${attempt}`).toEqual([]);
      expect(frames[0]!.data.cursor).toBe(opening.data.cursor);
    }
  });
});

describe('A DISCONNECT ENDS THE SESSION — the only thing that ever ends this stream', () => {
  it('unsubscribes and stops re-reading once the reader has gone', async () => {
    const spy = vi.spyOn(workbenchWatermarkService, 'read');
    const hub = getLiveSignalHub();
    const before = hub.subscriberCount;

    const res = await GET(req('/api/workbench/stream'));
    const reader = res.body!.getReader();
    await reader.read(); // the opening frame
    expect(hub.subscriberCount).toBe(before + 1);
    await listening();
    // A write while connected IS re-read, so the assertion below is about a
    // session that was live rather than one that never started.
    await card('Seen while connected');
    await until(() => spy.mock.calls.length > 1, 'the re-read a write causes');

    await reader.cancel();
    expect(hub.subscriberCount).toBe(before);
    const settled = spy.mock.calls.length;

    await card('Filed after the reader left');
    await sleep(WORKBENCH_STREAM_COALESCE_MS * 4);
    expect(spy.mock.calls.length).toBe(settled);
  });
});

// ⚠️ THE REQUEST'S ABORT SIGNAL IS THE OTHER WAY A READER LEAVES (MOTIR-8568).
// A reader who leaves BEFORE the handler returned its Response is never
// cancelled: the server does not start piping a response whose connection has
// already closed, so `cancel()` never runs, and the only thing that knows the
// reader has gone is `req.signal`. These drive the route the way that departure
// reaches it — the signal aborts and the body is NEVER cancelled.
describe('A DEPARTURE THE STREAM IS NEVER TOLD ABOUT STILL ENDS THE SESSION', () => {
  it('unsubscribes when the request aborts, with the body left uncancelled', async () => {
    const spy = vi.spyOn(workbenchWatermarkService, 'read');
    const hub = getLiveSignalHub();
    const before = hub.subscriberCount;
    const leave = new AbortController();

    const res = await GET(new Request(`${BASE}/api/workbench/stream`, { signal: leave.signal }));
    const reader = res.body!.getReader();
    await reader.read(); // the opening frame
    expect(hub.subscriberCount).toBe(before + 1);

    leave.abort();

    expect(hub.subscriberCount).toBe(before);
    await listening();
    await card('Filed after the reader left');
    await sleep(WORKBENCH_STREAM_COALESCE_MS * 4);
    expect(spy.mock.calls.length).toBe(1);

    // And the stream ENDS rather than hanging open with nobody writing to it.
    let done = false;
    while (!done) ({ done } = await reader.read());
  });

  it('opens no stream for a reader who left while the first read was in flight', async () => {
    const hub = getLiveSignalHub();
    const before = hub.subscriberCount;
    const leave = new AbortController();
    const actual = workbenchWatermarkService.read.bind(workbenchWatermarkService);
    const spy = vi
      .spyOn(workbenchWatermarkService, 'read')
      .mockImplementation(async (...args: Parameters<typeof actual>) => {
        const reading = await actual(...args);
        leave.abort();
        return reading;
      });

    const res = await GET(new Request(`${BASE}/api/workbench/stream`, { signal: leave.signal }));
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(hub.subscriberCount).toBe(before);

    await listening();
    await card('Filed after the reader left');
    await sleep(WORKBENCH_STREAM_COALESCE_MS * 4);
    expect(spy.mock.calls.length).toBe(1);
  });

  it('never subscribes for a reader whose request had already aborted', async () => {
    const subscribe = vi.spyOn(getLiveSignalHub(), 'subscribe');
    const leave = new AbortController();
    leave.abort();

    const res = await GET(new Request(`${BASE}/api/workbench/stream`, { signal: leave.signal }));

    expect(res.status).toBe(204);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe('A RE-READ THAT FAILS after the stream opened is logged, and the stream stays open', () => {
  it('writes no error frame and the next write is still delivered', async () => {
    // The first read succeeds — it is the one that happens BEFORE the stream is
    // constructed, and it is what makes a refusal a real status. The second
    // fails; the third is real again.
    let call = 0;
    // ⚠️ THE ORIGINAL IS CAPTURED BEFORE THE SPY REPLACES IT. `vi.importActual`
    // hands back the same service object this spy patched, so calling through it
    // re-enters the mock.
    const real = workbenchWatermarkService.read.bind(workbenchWatermarkService);
    vi.spyOn(workbenchWatermarkService, 'read').mockImplementation(async (...args) => {
      call += 1;
      if (call === 2) throw new Error('the database went away');
      return real(...args);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await GET(req('/api/workbench/stream'));
    expect(res.status).toBe(200);
    const reading = readFrames(res, 2, 10_000);
    await listening();

    await card('The read of this one fails');
    await until(() => call >= 2, 'the failing re-read');
    await sleep(WORKBENCH_STREAM_COALESCE_MS);
    await card('This one is delivered');

    const { frames } = await reading;
    expect(frames.map((f) => f.event)).toEqual([WORKBENCH_STREAM_FRAME, WORKBENCH_STREAM_FRAME]);
    expect(frames[1]!.data.moved).toContain('toDo');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[workbench-stream] re-read failed'),
      'the database went away',
    );
  });
});

describe('THE WATCHED-PLAN SET (MOTIR-8730)', () => {
  it('answers 400 with a JSON body, and NO read, for a malformed watch set', async () => {
    const spy = vi.spyOn(workbenchWatermarkService, 'read');
    const subscribe = vi.spyOn(getLiveSignalHub(), 'subscribe');
    const eleven = Array.from({ length: 11 }, (_, i) => `watch=p${i}%3A`).join('&');

    for (const query of ['watch=no-separator', 'watch=bad%20id%3Arv1.a', eleven]) {
      const res = await GET(req(`/api/workbench/stream?${query}`));
      expect(res.status, query).toBe(400);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      expect(await res.json()).toMatchObject({ code: 'INVALID_WATCH' });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('writes a plan frame when a watched plan is written to while the reader is connected', async () => {
    const { plansService } = await import('@/lib/services/plansService');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Watched' }, fx.ctx);
    const { planReviewService } = await import('@/lib/services/planReviewService');
    const current = await planReviewService.readReviewVersionForReader(plan.id, fx.ctx);

    const res = await GET(
      req(
        `/api/workbench/stream?watch=${encodeURIComponent(`${plan.id}:${current!.reviewVersion}`)}`,
      ),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 8_000;
    await listening();
    await plansService.addProposals(
      plan.id,
      [{ op: 'add' as const, proposedFields: { title: 'A card', kind: 'task' as const } }],
      fx.ctx,
    );
    while (!text.includes('event: plan') && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }) as const),
      ]);
      if (chunk.done || !chunk.value) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();

    const block = text.split('\n\n').find((b) => b.startsWith('event: plan'));
    expect(block, text).toBeDefined();
    const data = JSON.parse(/^data: (.+)$/m.exec(block!)![1]!);
    // A signal, never content: exactly the plan id and its new version.
    expect(Object.keys(data).sort()).toEqual(['planId', 'reviewVersion']);
    expect(data.planId).toBe(plan.id);
    expect(data.reviewVersion).not.toBe(current!.reviewVersion);
  });
});
