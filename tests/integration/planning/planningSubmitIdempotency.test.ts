import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { MOTIR_AI_REQUEST_TIMEOUT_MS } from '@/lib/ai/motirAiClient';
import { turnSubmitKey } from '@/lib/ai/turnSubmitKey';
import {
  planChangeSessionsService,
  planningSubmitKey,
} from '@/lib/services/planChangeSessionsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A PLANNING SUBMIT THAT OUTLIVES A WAKING motir-ai (MOTIR-9258), against a REAL
// Postgres. The motir-ai client is the real one; only `fetch` to motir-ai's
// `POST /v1/jobs` is stubbed, answering a repeated `idempotencyKey` with the job
// the first post created — what motir-ai does since MOTIR-9255.

const ORIGIN = 'http://motir-ai.planning-submit.test';
const T = { timeout: 120_000 };

let fx: WorkItemFixture;
/** Every `POST /v1/jobs` body motir-ai received, in order. */
let posts: Array<{ jobKind: string; idempotencyKey?: string }>;

/** A post that hangs until the client's own deadline aborts it. */
const hang = (init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });

const accepted = (jobId: string) =>
  new Response(JSON.stringify({ jobId, status: 'queued' }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });

/** Stub motir-ai: the first `lost` posts never answer; every post is answered
 *  with the job its key already created, else a new one. */
function stubMotirAi({ lost = 0 } = {}): void {
  const jobByKey = new Map<string, string>();
  let seq = 0;
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(`${ORIGIN}/v1/jobs`) || init.method !== 'POST') {
      throw new Error(`unexpected fetch ${url}`);
    }
    const body = JSON.parse(init.body as string) as { jobKind: string; idempotencyKey?: string };
    posts.push(body);
    const key = body.idempotencyKey ?? `keyless-${posts.length}`;
    const jobId = jobByKey.get(key) ?? `job-${++seq}`;
    jobByKey.set(key, jobId);
    // The job exists from the first post on; only its answer is lost.
    if (posts.length <= lost) return hang(init);
    return accepted(jobId);
  });
}

beforeEach(async () => {
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  posts = [];
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

async function openSession() {
  await adminDb.planChangeSession.updateMany({
    where: { endedAt: null },
    data: { endedAt: new Date(), endReason: 'restarted' },
  });
  return planChangeSessionsService.startWithFirstTurn(me(), PROJECT_SCOPE, 'Add CSV export');
}

const plansOf = (sessionId: string) => adminDb.plan.findMany({ where: { sessionId } });
const markersOf = (sessionId: string) =>
  adminDb.planChangeTurn.findMany({ where: { sessionId, role: 'system' } });

describe('a planning submit that outlives a waking motir-ai', () => {
  it(
    '⚠️ a first submit that TIMES OUT is re-sent under the same key, and the job it returns gets ONE plan',
    T,
    async () => {
      stubMotirAi({ lost: 1 });
      const s = await openSession();
      vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });

      const pending = planChangeSessionsService.submit(me(), { sessionId: s.id });
      await vi.waitFor(() => expect(posts).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(MOTIR_AI_REQUEST_TIMEOUT_MS + 5_000);
      const out = await pending;

      // Two posts under ONE key, keyed on the session's turn, and one job.
      expect(posts).toHaveLength(2);
      const userTurn = await adminDb.planChangeTurn.findFirstOrThrow({
        where: { sessionId: s.id, role: 'user' },
      });
      expect(posts[0]!.idempotencyKey).toBe(turnSubmitKey(userTurn.id, 'plan', null));
      expect(posts[1]!.idempotencyKey).toBe(posts[0]!.idempotencyKey);
      expect(out.jobId).toBe('job-1');

      const plans = await plansOf(s.id);
      expect(plans.map((p) => [p.id, p.sourceJobId])).toEqual([[out.planId, 'job-1']]);
      expect((await markersOf(s.id)).map((t) => t.jobId)).toEqual(['job-1']);
      const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.lastJobId).toBe('job-1');
    },
  );

  it(
    'two submits of one session answered with ONE job open ONE plan and record one marker',
    T,
    async () => {
      stubMotirAi();
      const s = await openSession();

      const [a, b] = await Promise.all([
        planChangeSessionsService.submit(me(), { sessionId: s.id }),
        planChangeSessionsService.submit(me(), { sessionId: s.id }),
      ]);

      expect(posts.map((p) => p.idempotencyKey)).toEqual([
        posts[0]!.idempotencyKey,
        posts[0]!.idempotencyKey,
      ]);
      expect(b.jobId).toBe(a.jobId);
      // The repeat is handed the job's existing plan, not a second one.
      expect(b.planId).toBe(a.planId);
      expect((await plansOf(s.id)).map((p) => p.id)).toEqual([a.planId]);
      expect((await markersOf(s.id)).map((t) => t.jobId)).toEqual([a.jobId]);
    },
  );
});

describe('planningSubmitKey', () => {
  const turns = [
    { id: 't1', role: 'user' as const, seq: 0 },
    { id: 'm1', role: 'system' as const, seq: 1 },
    { id: 't2', role: 'user' as const, seq: 2 },
    { id: 'a1', role: 'assistant' as const, seq: 3 },
  ];

  it('keys on the newest user turn and the job the session held before', () => {
    expect(planningSubmitKey(turns, 'job-1')).toBe(turnSubmitKey('t2', 'plan', 'job-1'));
    expect(planningSubmitKey([...turns].reverse(), null)).toBe(turnSubmitKey('t2', 'plan', null));
  });

  it('a submit after the session took a job is a NEW key, so it runs fresh', () => {
    expect(planningSubmitKey(turns, 'job-2')).not.toBe(planningSubmitKey(turns, 'job-1'));
  });

  it('no user turn ⇒ no key', () => {
    expect(planningSubmitKey([{ id: 'm1', role: 'system', seq: 0 }], null)).toBeUndefined();
  });
});
