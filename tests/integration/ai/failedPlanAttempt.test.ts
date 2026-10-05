import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { PlanJobStateDto } from '@/lib/dto/plans';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-7628 — after a FAILED planning attempt the session read "writing" for up
// to an hour, then "declined", though nobody declined it and the conversation was
// waiting for the person.
//
// A plan IS its planning session (MOTIR-6011) and each submit is an attempt that
// opens a `generating` plan bound to its job (MOTIR-6022). Core gets no failure
// callback from motir-ai, so a failed attempt stayed `generating` until the
// hourly abandoned-plan sweep declined it — and the session's state, which was
// its latest plan's status, showed both lies in turn.
//
// What these lock:
//   * AC 1 — the stream route that relays the terminal `failed` frame ENDS the
//     attempt in the same handling and gives back the cards it parked, on BOTH
//     conversation doors (the project thread's augment relay and the item's own);
//   * AC 2 — a session whose latest attempt failed reads as its previous version
//     or `none`, on the session read, the Plans list, its filter and its counts —
//     while a PERSON's decline still reads `declined`;
//   * AC 3 — a retry opens a new attempt that reads `generating`, then its own
//     state;
//   * AC 4 — the conversation and the sweep racing on one attempt end it ONCE.
//
// Real Postgres, real services and repositories. Mocked: the motir-ai client
// (the external boundary) and the two context resolvers the test env cannot
// supply without cookies — the convention the sibling route suites keep.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn();
const streamJobMock = vi.fn();
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  streamJob: (...args: unknown[]) => streamJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...args),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { GET: augmentStream } = await import('@/app/api/ai/augment/[jobId]/stream/route');
const { GET: itemStream } = await import('@/app/api/work-items/[id]/ai/plan/[jobId]/stream/route');
const { POST: itemPlan } = await import('@/app/api/work-items/[id]/ai/plan/route');
const { plansService } = await import('@/lib/services/plansService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { abandonedPlanService, ABANDONED_PLAN_GRACE_MINUTES } =
  await import('@/lib/services/abandonedPlanService');
const { planRepository } = await import('@/lib/repositories/planRepository');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');

const DB_TEST_TIMEOUT_MS = 30_000;

/** What the sweep's ask hears about a failed job. */
const FAILED_JOB: PlanJobStateDto = { reachable: true, status: 'failed', failure: null };
const BASE = 'http://localhost:3000';

let fx: WorkItemFixture;

function pctx(): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  submitJobMock.mockResolvedValue({ jobId: 'job-retry' });
  streamJobMock.mockReset();
  getJobMock.mockReset();
  getJobMock.mockResolvedValue({
    jobId: 'job',
    status: 'failed',
    result: null,
    error: { code: 'MOTIR_AI_JOB_FAILED', message: 'the planner crashed' },
  });
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = pctx();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The job's relayed SSE, ending on the given terminal status. */
function framesEndingIn(status: 'failed' | 'canceled' | 'succeeded'): void {
  streamJobMock.mockImplementation(async function* (): AsyncGenerator<JobStreamEvent> {
    yield { event: 'status', data: { status: 'running' } };
    yield { event: 'progress', data: { kind: 'search' } };
    yield { event: 'status', data: { status } };
    yield { event: 'done', data: {} };
  });
}

async function drain(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  return res.text();
}

/** A planning CONVERSATION — the session every attempt belongs to. Anchored at
 *  `keys`, it holds those cards at Planning under its own lease, as the item
 *  thread the report was dogfooding did; with none it is the project thread. */
async function conversation(keys: string[] = []): Promise<string> {
  const scope = keys.length > 0 ? buildScope(keys) : PROJECT_SCOPE;
  const s = await planChangeSessionsService.startWithFirstTurn(pctx(), scope, 'Plan it');
  return s.id;
}

/** One ATTEMPT: a `generating` plan bound to `jobId` inside the session. A
 *  conversation's attempt parks nothing of its own (the session holds its
 *  anchor — MOTIR-5648). */
async function attempt(
  sessionId: string,
  jobId: string,
  opts: { ageMs?: number } = {},
): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: `attempt ${jobId}`, sourceJobId: jobId, session: { sessionId } },
    fx.ctx,
  );
  if (opts.ageMs !== undefined) {
    await adminDb.plan.update({
      where: { id: plan.id },
      data: { createdAt: new Date(Date.now() - opts.ageMs) },
    });
  }
  return plan.id;
}

/** A generation plan OUTSIDE a conversation (its session holds no leases), that
 *  has appended a proposal touching `parks` — so the PLAN holds that card. */
async function parkingPlan(jobId: string, parks: string): Promise<string> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: `generation ${jobId}`, sourceJobId: jobId, session: { origin: 'mcp' } },
    fx.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: parks, patch: { descriptionMd: 'Half-written.' } }],
    fx.ctx,
  );
  return plan.id;
}

async function planRow(id: string) {
  return adminDb.plan.findUniqueOrThrow({ where: { id } });
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockOn(id: string) {
  return adminDb.planTargetLock.findUnique({ where: { workItemId: id } });
}

/** A card at `status` — created through the service, which seeds the project's
 *  workflow, so the park's `→ planning` edge exists. */
async function card(status: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { status } });
  return { id: item.id, identifier: item.identifier };
}

async function sessionRow(sessionId: string) {
  const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);
  return page.sessions.find((s) => s.id === sessionId)!;
}

describe('AC 1 — the stream that relays the failure ends the attempt', () => {
  it(
    'item thread (the reported case): the attempt is ended and the anchored card is restored',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('implemented');
      const sessionId = await conversation([target.identifier]);
      const planId = await attempt(sessionId, 'job-item');
      expect(await statusOf(target.id)).toBe(PLANNING_STATUS_KEY);
      framesEndingIn('failed');

      const body = await drain(
        await itemStream(new Request(BASE), {
          params: Promise.resolve({ id: target.id, jobId: 'job-item' }),
        }),
      );

      // The relay itself is unchanged — the client still hears the failure.
      expect(body).toContain('"status":"failed"');
      const row = await planRow(planId);
      expect(row).toMatchObject({
        status: 'declined',
        decisionReason: 'abandoned',
        decidedById: null,
      });
      expect(row.decidedAt).not.toBeNull();
      expect(await statusOf(target.id)).toBe('implemented');
      expect(await lockOn(target.id)).toBeNull();
    },
  );

  it(
    'project thread: a failed generation that parked a card hands it back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('todo');
      const planId = await parkingPlan('job-gen', target.id);
      expect(await statusOf(target.id)).toBe(PLANNING_STATUS_KEY);
      framesEndingIn('failed');

      await drain(
        await augmentStream(new Request(BASE), { params: Promise.resolve({ jobId: 'job-gen' }) }),
      );

      expect(await planRow(planId)).toMatchObject({
        status: 'declined',
        decisionReason: 'abandoned',
      });
      expect(await statusOf(target.id)).toBe('todo');
      expect(await lockOn(target.id)).toBeNull();
    },
  );

  it(
    'an OLDER attempt failing late leaves the conversation’s newer attempt holding its card',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('implemented');
      const sessionId = await conversation([target.identifier]);
      const older = await attempt(sessionId, 'job-old', { ageMs: 60_000 });
      await attempt(sessionId, 'job-new');

      const out = await abandonedPlanService.endFailedAttempt('job-old', pctx());

      expect(out).toEqual({ outcome: 'ended', planId: older, released: 0 });
      expect(await statusOf(target.id)).toBe(PLANNING_STATUS_KEY);
      expect(await lockOn(target.id)).not.toBeNull();
    },
  );

  it('a CANCELED job ends its attempt too', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const sessionId = await conversation();
    const planId = await attempt(sessionId, 'job-c');
    framesEndingIn('canceled');

    await drain(
      await augmentStream(new Request(BASE), { params: Promise.resolve({ jobId: 'job-c' }) }),
    );

    expect((await planRow(planId)).status).toBe('declined');
  });

  it(
    'a SUCCEEDED job is not a failure — its plan is left for markPlanned',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('implemented');
      const sessionId = await conversation([target.identifier]);
      const planId = await attempt(sessionId, 'job-ok');
      framesEndingIn('succeeded');

      await drain(
        await itemStream(new Request(BASE), {
          params: Promise.resolve({ id: target.id, jobId: 'job-ok' }),
        }),
      );

      expect((await planRow(planId)).status).toBe('generating');
      expect(await statusOf(target.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it(
    'leaves a plan that is no longer generating alone',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await conversation();
      const planId = await attempt(sessionId, 'job-p');
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });

      const out = await abandonedPlanService.endFailedAttempt('job-p', pctx());

      expect(out).toEqual({ outcome: 'left_as_is', planId });
      expect((await planRow(planId)).status).toBe('planned');
    },
  );

  it('answers left_as_is for a job with no plan in this project', async () => {
    expect(await abandonedPlanService.endFailedAttempt('job-nobody', pctx())).toEqual({
      outcome: 'left_as_is',
      planId: null,
    });

    const sessionId = await conversation();
    const planId = await attempt(sessionId, 'job-elsewhere');
    const other = await makeWorkItemFixture();
    // The same job id read from ANOTHER project's context finds nothing to end.
    const out = await abandonedPlanService.endFailedAttempt('job-elsewhere', {
      userId: other.ownerId,
      workspaceId: other.workspaceId,
      projectId: other.projectId,
    });
    expect(out.outcome).toBe('left_as_is');
    expect((await planRow(planId)).status).toBe('generating');
  });
});

describe('AC 2 — a session whose latest attempt failed is neither writing nor declined', () => {
  it(
    'with no earlier version it reads `none` on the list, the filter, the counts and the session read',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await conversation();
      await attempt(sessionId, 'job-1');
      framesEndingIn('failed');

      // Writing while the attempt runs — the baseline the failure must undo.
      expect((await sessionRow(sessionId)).latestPlan?.status).toBe('generating');

      await drain(
        await augmentStream(new Request(BASE), { params: Promise.resolve({ jobId: 'job-1' }) }),
      );

      const row = await sessionRow(sessionId);
      expect(row.latestPlan).toBeNull();
      expect(row.planCount).toBe(0);

      const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
      expect(counts).toMatchObject({ none: 1, generating: 0, declined: 0 });
      const none = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
        planState: 'none',
      });
      expect(none.sessions.map((s) => s.id)).toEqual([sessionId]);
      for (const state of ['generating', 'declined'] as const) {
        const page = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
          planState: state,
        });
        expect(page.sessions).toEqual([]);
      }

      const read = await planChangeSessionsService.getById(pctx(), sessionId);
      expect(read.pendingPlanId).toBeNull();
    },
  );

  it(
    'with an earlier version it reads as THAT version, and the session read points at it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await conversation();
      const first = await attempt(sessionId, 'job-v1', { ageMs: 10 * 60_000 });
      await adminDb.plan.update({ where: { id: first }, data: { status: 'planned' } });
      await attempt(sessionId, 'job-v2');

      await abandonedPlanService.endFailedAttempt('job-v2', pctx());

      const row = await sessionRow(sessionId);
      expect(row.latestPlan).toMatchObject({ id: first, status: 'planned' });
      expect(row.planCount).toBe(1);
      const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
      expect(counts).toMatchObject({ planned: 1, generating: 0, declined: 0 });
      expect((await planChangeSessionsService.getById(pctx(), sessionId)).pendingPlanId).toBe(
        first,
      );
    },
  );

  it(
    'an attempt the SWEEP ended is skipped exactly the same way',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await conversation();
      await attempt(sessionId, 'job-swept', { ageMs: (ABANDONED_PLAN_GRACE_MINUTES + 5) * 60_000 });

      const summary = await abandonedPlanService.reconcileAbandoned({
        deps: { resolveJobState: async () => FAILED_JOB },
      });

      expect(summary.declined).toBe(1);
      expect((await sessionRow(sessionId)).latestPlan).toBeNull();
    },
  );

  it('a PERSON’s decline still reads `declined`', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const sessionId = await conversation();
    const planId = await attempt(sessionId, 'job-d');

    await plansService.declinePlan(planId, fx.ctx);

    expect((await sessionRow(sessionId)).latestPlan).toMatchObject({
      id: planId,
      status: 'declined',
    });
    const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
    expect(counts.declined).toBe(1);
  });
});

describe('AC 3 — a retry in the same session', () => {
  it(
    'the item thread’s Retry opens a new attempt, re-parks the card, and reads writing then its own state',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const target = await card('implemented');
      const sessionId = await conversation([target.identifier]);
      const failed = await attempt(sessionId, 'job-first', { ageMs: 60_000 });
      framesEndingIn('failed');
      await drain(
        await itemStream(new Request(BASE), {
          params: Promise.resolve({ id: target.id, jobId: 'job-first' }),
        }),
      );
      expect(await statusOf(target.id)).toBe('implemented');
      expect((await sessionRow(sessionId)).latestPlan).toBeNull();

      // The rail's Retry: re-send the thread's intent, no new turn.
      const res = await itemPlan(
        new Request(`${BASE}/api/work-items/${target.id}/ai/plan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resubmit: true, sessionId }),
        }),
        { params: Promise.resolve({ id: target.id }) },
      );
      expect(res.status).toBe(200);
      const {
        jobId,
        planId,
        sessionId: same,
      } = (await res.json()) as {
        jobId: string;
        planId: string;
        sessionId: string;
      };

      expect({ jobId, same }).toEqual({ jobId: 'job-retry', same: sessionId });
      expect(planId).not.toBe(failed);
      // The conversation holds its anchor again for the new attempt.
      expect(await statusOf(target.id)).toBe(PLANNING_STATUS_KEY);
      expect((await sessionRow(sessionId)).latestPlan).toMatchObject({
        id: planId,
        status: 'generating',
      });

      await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });
      expect((await sessionRow(sessionId)).latestPlan).toMatchObject({
        id: planId,
        status: 'planned',
      });
    },
  );

  it(
    'opens a new attempt that reads as writing, then as its own state',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await conversation();
      await attempt(sessionId, 'job-try1', { ageMs: 60_000 });
      await abandonedPlanService.endFailedAttempt('job-try1', pctx());
      expect((await sessionRow(sessionId)).latestPlan).toBeNull();

      const retry = await attempt(sessionId, 'job-try2');
      expect((await sessionRow(sessionId)).latestPlan).toMatchObject({
        id: retry,
        status: 'generating',
      });

      await adminDb.plan.update({ where: { id: retry }, data: { status: 'planned' } });
      expect((await sessionRow(sessionId)).latestPlan).toMatchObject({
        id: retry,
        status: 'planned',
      });
      expect((await sessionRow(sessionId)).planCount).toBe(1);
    },
  );
});

describe('AC 4 — the conversation and the sweep never both end one attempt', () => {
  it('racing on the same attempt, exactly one of them ends it', { timeout: 60_000 }, async () => {
    const sweepDeps = { resolveJobState: async () => FAILED_JOB };
    for (let round = 0; round < 5; round += 1) {
      const sessionId = await conversation();
      const planId = await attempt(sessionId, `job-race-${round}`, {
        ageMs: (ABANDONED_PLAN_GRACE_MINUTES + 5) * 60_000,
      });

      const [conv, sweep] = await Promise.all([
        abandonedPlanService.endFailedAttempt(`job-race-${round}`, pctx()),
        abandonedPlanService.reconcileAbandoned({ deps: sweepDeps }),
      ]);

      // Every legitimate interleaving ends it once: the conversation first (the
      // sweep then never selects it, or reads it moved), or the sweep first
      // (the conversation then finds it decided).
      const sweepOutcome = sweep.outcomes.find((o) => o.planId === planId);
      const convEnded = conv.outcome === 'ended';
      const sweepEnded = sweepOutcome?.outcome === 'declined';
      expect(convEnded !== sweepEnded).toBe(true);
      if (sweepOutcome && !sweepEnded) expect(sweepOutcome.reason).toBe('row_moved');
      expect((await planRow(planId)).status).toBe('declined');
    }
  });

  it(
    'the conversation landing while the sweep is asking about the job makes the sweep stand down',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await conversation();
      const planId = await attempt(sessionId, 'job-mid', {
        ageMs: (ABANDONED_PLAN_GRACE_MINUTES + 5) * 60_000,
      });
      let conv: Awaited<ReturnType<typeof abandonedPlanService.endFailedAttempt>> | null = null;

      // The sweep has DISCOVERED the attempt (it is asking motir-ai about its
      // job); the conversation ends it in that window — the exact interleaving
      // a non-locking re-read cannot see.
      const sweep = await abandonedPlanService.reconcileAbandoned({
        deps: {
          resolveJobState: async () => {
            conv = await abandonedPlanService.endFailedAttempt('job-mid', pctx());
            return FAILED_JOB;
          },
        },
      });

      expect(conv).toMatchObject({ outcome: 'ended', planId });
      expect(sweep.declined).toBe(0);
      expect(sweep.outcomes).toEqual([
        { planId, projectId: fx.projectId, outcome: 'left_as_is', reason: 'row_moved' },
      ]);
    },
  );

  it(
    'two observers of the same failed job end its attempt once',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await conversation();
      const planId = await attempt(sessionId, 'job-twice');

      const outs = await Promise.all([
        abandonedPlanService.endFailedAttempt('job-twice', pctx()),
        abandonedPlanService.endFailedAttempt('job-twice', pctx()),
      ]);

      expect(outs.filter((o) => o.outcome === 'ended')).toHaveLength(1);
      expect(outs.filter((o) => o.outcome === 'left_as_is')).toEqual([
        { outcome: 'left_as_is', planId },
      ]);
    },
  );

  it('the compare-and-set lets a second ender match nothing', async () => {
    const sessionId = await conversation();
    const planId = await attempt(sessionId, 'job-cas');
    const end = (tx: Parameters<typeof planRepository.endGenerating>[2]) =>
      planRepository.endGenerating(
        planId,
        { status: 'declined', decidedAt: new Date(), decisionReason: 'abandoned' },
        tx,
      );

    const first = await withWorkspaceServiceContext(fx.workspaceId, end);
    const second = await withWorkspaceServiceContext(fx.workspaceId, end);

    expect([first, second]).toEqual([true, false]);
  });
});
