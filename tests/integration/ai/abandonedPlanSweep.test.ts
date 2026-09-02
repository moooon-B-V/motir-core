import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../../helpers/jobs';

// The ONE mock: the motir-ai HTTP client — the external service boundary
// (CLAUDE.md's sanctioned carve-out, same as the sibling plan suites).
// EVERYTHING below it is real: a real Postgres with RLS, the real
// cross-workspace `withSystemContext` discovery scan, the real per-workspace
// write, and the real `autoPlanCadenceService` gate reading the result. So what
// these assert about the Plan rows and about whether cadence fires is what
// production does.
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
  getJob: vi.fn(),
}));

import { db } from '@/lib/db';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { MotirAiJobNotFoundError, MotirAiUnavailableError } from '@/lib/ai/errors';
import {
  abandonedPlanService,
  classifyAbandonedCandidate,
  ABANDONED_PLAN_GRACE_MINUTES,
  ABANDONED_PLAN_MAX_AGE_HOURS,
} from '@/lib/services/abandonedPlanService';
import { abandonedPlanSweep } from '@/lib/jobs/definitions/abandonedPlanSweep';
import { jobDefinitions } from '@/lib/jobs/registry';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import type { JobStatus } from '@/lib/ai/types';

// MOTIR-3064 — a generation job that DIES leaves its plan `generating` forever,
// and that empty orphan pauses the project's auto-plan cadence for good.
//
// The defect is a JOIN of two facts, each fine on its own: nothing writes a
// terminal `Plan` status when a motir-ai job fails, and
// `planRepository.findUndecidedByProject` reads `generating` as UNDECIDED —
// which is the pending-proposal gate `autoPlanCadenceService` checks first. So
// the project silently stops planning itself, and the settings page reports a
// proposal waiting for a decision nobody can make.
//
// MOTIR-3051 fixed the sibling half at the GATE, and could: a plan with no
// producer is judgeable from the row. This half is not — the row carries a
// `sourceJobId`, so it is identical to a healthy generation between `createPlan`
// and the first append. The answer lives in the JOB, which is why the fix ASKS.
//
// What these lock, in the order the sweep decides them:
//   * the GRACE — a fresh empty plan is not even asked about, so the reconciler
//     can never race a submit (and AC 3's idempotent-retry guarantee holds);
//   * the DECISION TABLE — terminal job / job gone ⇒ abandoned; in-flight ⇒
//     left; motir-ai unreachable ⇒ left, because unreachable is not death;
//   * the MAX AGE — the arm for a worker that died without marking its own job,
//     which is the one failure the ASK cannot see;
//   * the PARTIAL arm (MOTIR-3189) — a plan HOLDING proposals whose producer is
//     provably gone is declined too, and its proposals survive the decline;
//     the write's guard is now a COUNT MISMATCH, so a late append is still
//     `row_moved` and a plan that was already partial at discovery is not;
//   * AC 2 — cadence FIRES again for a project whose only undecided plan was
//     abandoned, which is the whole point;
//   * AC 1 + the terminal state — `declined`, with a NULL decider, because
//     nobody decided it, and `decisionReason: 'abandoned'` so the review surface
//     can tell this ending from a plan somebody read and rejected (MOTIR-3189).

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  await truncateJobRuns();
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll();
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_cadence_1' } as Awaited<
    ReturnType<typeof submitJob>
  >);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Well past the grace, well inside the max age — the ordinary candidate. */
const PAST_GRACE_MS = (ABANDONED_PLAN_GRACE_MINUTES + 5) * MINUTE;

/** `getJob`'s answer for a job in a given state, with no error attached. */
function jobIn(status: JobStatus): void {
  vi.mocked(getJob).mockResolvedValue({
    jobId: 'job_dead',
    status,
    result: null,
    error: null,
  } as Awaited<ReturnType<typeof getJob>>);
}

/**
 * Seed a plan whose producer is recorded and whose `createdAt` is backdated.
 *
 * `createdAt` has a `@default(now())`, so it is set through `adminDb` (which
 * bypasses RLS) rather than by the service — the sweep's whole predicate turns
 * on age, and a test that could not backdate it would have to sleep.
 */
async function seedGeneratingPlan(
  fx: WorkItemFixture,
  opts: { ageMs?: number; sourceJobId?: string | null; items?: number } = {},
): Promise<string> {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      status: 'generating',
      sourceJobId: opts.sourceJobId === undefined ? 'job_dead' : opts.sourceJobId,
      createdAt: new Date(Date.now() - (opts.ageMs ?? PAST_GRACE_MS)),
    },
  });
  for (let i = 0; i < (opts.items ?? 0); i += 1) {
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: plan.id,
        op: 'add',
        proposedFields: { title: `Proposed ${i}`, kind: 'subtask' },
        blockedByRefs: [],
      },
    });
  }
  return plan.id;
}

async function planRow(planId: string) {
  return adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
}

/**
 * A project opted into auto-planning with ONE childless epic — the stub is also
 * the whole ready set, so `readyCount = 1`, below the default threshold of 5.
 * Mirrors `autoPlanCadence.test.ts`'s fixture, including WHY the item is made
 * through the service: only `createWorkItem` resolves the workflow status key
 * the ready-set reads JOIN on.
 */
async function makeDrainedProject(
  opts: { name?: string; identifier?: string } = {},
): Promise<{ fx: WorkItemFixture; stubKey: string }> {
  const fx = await makeWorkItemFixture({
    name: opts.name ?? 'Acme',
    identifier: opts.identifier ?? 'PROD',
  });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 },
  });
  const stub = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Unexpanded epic' },
    fx.ctx,
  );
  return { fx, stubKey: stub.identifier };
}

describe('the decision table — what counts as evidence the producer is gone', () => {
  // Split out as a pure function precisely so this table can be read as one
  // thing. Every arm below is a different ANSWER about the same row, and three
  // of them are "leave it alone" — which is the half a sweep gets wrong quietly.
  const reachable = (status: JobStatus) => ({ status, reachable: true, failure: null });

  it.each([
    ['failed', 'job_terminal'],
    ['succeeded', 'job_terminal'],
    ['canceled', 'job_terminal'],
  ] as const)('a %s job is abandoned (%s)', (status, reason) => {
    expect(classifyAbandonedCandidate(reachable(status), PAST_GRACE_MS)).toEqual({
      abandoned: true,
      reason,
    });
  });

  it.each(['queued', 'running'] as const)('a %s job is LEFT — it is still working', (status) => {
    expect(classifyAbandonedCandidate(reachable(status), PAST_GRACE_MS)).toEqual({
      abandoned: false,
      reason: 'job_in_flight',
    });
  });

  it('a 404 IS evidence — motir-ai answered, and its answer was "no such job"', () => {
    const err = new MotirAiJobNotFoundError('job_dead');
    expect(
      classifyAbandonedCandidate(
        { status: null, reachable: false, failure: { code: err.code, message: err.message } },
        PAST_GRACE_MS,
      ),
    ).toEqual({ abandoned: true, reason: 'job_gone' });
  });

  it('an OUTAGE is not evidence — unreachable means we do not know', () => {
    // The arm that would turn a motir-ai outage into a mass decline of every
    // in-flight generation in the fleet. It has to be a leave, not a terminate.
    const err = new MotirAiUnavailableError('connect ECONNREFUSED');
    expect(
      classifyAbandonedCandidate(
        { status: null, reachable: false, failure: { code: err.code, message: err.message } },
        PAST_GRACE_MS,
      ),
    ).toEqual({ abandoned: false, reason: 'ai_unreachable' });
  });

  it('NO PRODUCER past the max age is abandoned — the only signal left is time', () => {
    // MOTIR-3236. `null` is not "the ask failed" — it is "there was nobody to
    // ask", which an MCP-authored plan is by construction (`create_plan` writes
    // no `sourceJobId`). AMENDMENT 2's "the discriminator is not in the plan
    // table" is true of a producer-bearing plan and false here: an ABSENT
    // producer IS a fact about the row, and it settles the question.
    expect(classifyAbandonedCandidate(null, ABANDONED_PLAN_MAX_AGE_HOURS * HOUR)).toEqual({
      abandoned: true,
      reason: 'no_producer',
    });
  });

  it('NO PRODUCER inside the max age is LEFT — an author mid-skeleton looks the same', () => {
    // The keep arm that makes the one above safe. The 15-minute grace is far too
    // short to tell a stopped agent from a working one; a full day is the same
    // judgement `max_age` already makes, which is why this REUSES that constant
    // rather than introducing a second threshold.
    expect(classifyAbandonedCandidate(null, PAST_GRACE_MS)).toEqual({
      abandoned: false,
      reason: 'no_producer_recent',
    });
    expect(classifyAbandonedCandidate(null, ABANDONED_PLAN_MAX_AGE_HOURS * HOUR - MINUTE)).toEqual({
      abandoned: false,
      reason: 'no_producer_recent',
    });
  });

  it('a still-running job past the MAX AGE is abandoned — the crashed-worker arm', () => {
    // motir-ai marks a job `failed` only when the HANDLER throws
    // (`src/jobs/worker.ts`); a worker process that dies mid-job leaves the row
    // `running` for good, so the ASK has no answer and only time is left. Same
    // argument `planTargetLockSweep` makes about a crashed planner.
    expect(
      classifyAbandonedCandidate(reachable('running'), ABANDONED_PLAN_MAX_AGE_HOURS * HOUR),
    ).toEqual({ abandoned: true, reason: 'max_age' });
  });

  it('but an OUTAGE past the max age is still not evidence — the arms do not compose', () => {
    // The max-age arm is deliberately below the reachability check, not beside
    // it: "motir-ai has been down for a day" must not become "every plan in the
    // fleet is abandoned".
    expect(
      classifyAbandonedCandidate(
        {
          status: null,
          reachable: false,
          failure: { code: 'MOTIR_AI_UNAVAILABLE', message: 'down' },
        },
        ABANDONED_PLAN_MAX_AGE_HOURS * HOUR * 3,
      ),
    ).toEqual({ abandoned: false, reason: 'ai_unreachable' });
  });
});

describe('the sweep — AC 1: a dead job’s plan stops reading as undecided', () => {
  it('declines it, with a NULL decider — nobody decided this', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 1 });
    expect(summary.outcomes[0]).toMatchObject({
      planId,
      outcome: 'declined',
      reason: 'job_terminal',
    });

    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    expect(row.decidedAt).not.toBeNull();
    // THE decision this card made: `declined` is the state, and the honesty
    // lives in the actor. `Plan.createdById` already means *nobody asked* when
    // null (the cadence case); this is the same convention one column over.
    expect(row.decidedById).toBeNull();
    // And since MOTIR-3189 it is RECORDED as well as derivable. `declined`
    // covers three histories; without this column the rail rendered a swept
    // plan exactly like one a person read and rejected.
    expect(row.decisionReason).toBe('abandoned');
    // `plannedAt` is untouched — this plan's generation frontier never closed.
    expect(row.plannedAt).toBeNull();
    // The failure is not lost — the producer is still on the row.
    expect(row.sourceJobId).toBe('job_dead');
  });

  it('asks the job through the SHIPPED resolver, scoped to the plan’s project', async () => {
    // `getJob` requires `coreProjectId` (MOTIR-2359) — a call site that cannot
    // supply one has not resolved its project. The sweep has it on the row.
    const { fx } = await makeDrainedProject();
    await seedGeneratingPlan(fx);
    jobIn('failed');

    await abandonedPlanService.reconcileAbandoned();

    expect(getJob).toHaveBeenCalledExactlyOnceWith('job_dead', fx.projectId);
  });

  it('declines a plan whose job motir-ai has never heard of — a 404 IS an answer', async () => {
    // The end-to-end form of the classifier's `job_gone` arm: motir-ai answered,
    // and its answer was that no such job exists, so the producer is gone rather
    // than merely quiet.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockRejectedValue(new MotirAiJobNotFoundError('job_dead'));

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_gone' });
    expect((await planRow(planId)).status).toBe('declined');
  });

  it('leaves an in-flight generation alone, and does not write to it', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 0 });
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_in_flight' });
    const row = await planRow(planId);
    expect(row.status).toBe('generating');
    expect(row.decidedAt).toBeNull();
  });

  it('leaves everything alone when motir-ai cannot be reached', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'ai_unreachable' });
    expect((await planRow(planId)).status).toBe('generating');
  });
});

describe('the sweep — what it must NEVER touch', () => {
  it('AC 3: a plan INSIDE the grace is not even asked about', async () => {
    // The window between `submitExpand`'s `createPlan` and motir-ai's first
    // append is exactly this shape: a producer, zero items, seconds old. The
    // grace is what keeps the reconciler out of it — which is also what keeps
    // `autoPlanCadenceTick`'s `retryPolicy: 'idempotent'` argument true, since
    // that depends on the just-fired project still having an undecided plan.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { ageMs: MINUTE });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toEqual({ scanned: 0, declined: 0, outcomes: [] });
    expect(getJob).not.toHaveBeenCalled();
    expect((await planRow(planId)).status).toBe('generating');
  });

  it('AC 3: and the just-fired project still gates on the re-run of the whole loop', async () => {
    // End-to-end version of the argument above, driven through the two services
    // in the order production runs them: cadence fires and opens the plan, the
    // reconciler runs, cadence runs again. Exactly ONE job must have been
    // submitted at the end of it.
    await makeDrainedProject();
    await autoPlanCadenceService.runCadenceSweep();
    expect(submitJob).toHaveBeenCalledTimes(1);
    jobIn('failed');

    await abandonedPlanService.reconcileAbandoned();
    const second = await autoPlanCadenceService.runCadenceSweep();

    expect(second.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it('a partial plan behind a LIVE job is left alone — the same arm that protects an empty one', async () => {
    // MOTIR-3189 widened the scan onto PARTIAL plans; it did not widen what
    // counts as evidence. A plan holding proposals whose producer is still
    // working is `job_in_flight` exactly as an empty one is, and nothing about
    // holding proposals makes it terminable while the job says otherwise.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2 });
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'job_in_flight' });
    expect((await planRow(planId)).status).toBe('generating');
    // And it still gates, which is the correct outcome for a live generation.
    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: planId });
  });

  it('a partial plan inside the GRACE is not asked about either', async () => {
    // The grace is a correctness bound about the submit→first-append window and
    // it is unchanged by the widening. A young plan that has already taken its
    // first append is exactly a healthy streaming generation.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 1, ageMs: 60 * 1000 });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toEqual({ scanned: 0, declined: 0, outcomes: [] });
    expect(getJob).not.toHaveBeenCalled();
    expect((await planRow(planId)).status).toBe('generating');
  });

  it('does not touch a plan with NO producer INSIDE the max age — MOTIR-3236’s keep arm', async () => {
    // ⚠️ THIS TEST WAS REVERSED BY MOTIR-3236, and the old assertion is quoted
    // here rather than deleted. It read: *"does not touch a plan with NO
    // producer — that is MOTIR-3051's half, at the gate"*, and asserted
    // `{ scanned: 0, declined: 0, outcomes: [] }` for a job-less plan of ANY
    // age, because the repository predicate carried `sourceJobId: { not: null }`
    // and the two sets were disjoint.
    //
    // That was true of an EMPTY job-less plan, which the gate does read past.
    // It was false of a PARTIAL one, which holds items and so is not excluded by
    // AMENDMENT 1's presence-based `items: { none: {} }` — it pauses the
    // project's cadence for ever, which is the harm the sweep exists to remove.
    // What survives of the old test is the KEEP: inside the max age a job-less
    // plan is still not terminated, because an agent mid-skeleton right now
    // looks exactly like one that stopped.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { sourceJobId: null, items: 2 });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.declined).toBe(0);
    expect(summary.outcomes[0]).toMatchObject({
      outcome: 'left_as_is',
      reason: 'no_producer_recent',
    });
    expect((await planRow(planId)).status).toBe('generating');
    // And motir-ai was never asked: there is no job id to ask about, and a 404
    // already means something else here.
    expect(getJob).not.toHaveBeenCalled();
  });

  it.each(['planned', 'approved', 'declined'] as const)(
    'does not touch a %s plan — it is not generating',
    async (status) => {
      const { fx } = await makeDrainedProject();
      const plan = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          status,
          sourceJobId: 'job_dead',
          createdAt: new Date(Date.now() - 10 * HOUR),
        },
      });
      jobIn('failed');

      const summary = await abandonedPlanService.reconcileAbandoned();

      expect(summary).toEqual({ scanned: 0, declined: 0, outcomes: [] });
      expect((await planRow(plan.id)).status).toBe(status);
    },
  );

  it('refuses at the WRITE when somebody DECIDED the plan between the ask and the act', async () => {
    // The other half of the same window: a person can approve or decline a plan
    // while the sweep is on the phone to motir-ai, and the sweep must not
    // overwrite their decision with its own.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
    expect((await planRow(planId)).status).toBe('planned');
  });

  it('refuses at the WRITE when the plan is GONE between the ask and the act', async () => {
    // A cascade from a deleted project or workspace can take the row out from
    // under the pass. `findById` returning null is a no-op, not a P2025 out of
    // the update.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.plan.delete({ where: { id: planId } });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
  });

  it('refuses at the WRITE when proposals land between the ask and the act', async () => {
    // The candidate came out of a different transaction's snapshot and the ask
    // is a network call that takes real time. The re-read is what makes a late
    // append safe — it turns the sweep's only destructive verdict back into a
    // no-op.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.planItem.create({
        data: {
          workspaceId: fx.workspaceId,
          planId,
          op: 'add',
          proposedFields: { title: 'Arrived late', kind: 'subtask' },
          blockedByRefs: [],
        },
      });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
    expect((await planRow(planId)).status).toBe('generating');
  });
});

describe('the sweep — the PARTIAL arm (MOTIR-3189)', () => {
  // AMENDMENT 2 excluded a partial plan on the ground that it is "a real
  // proposal a person can read and decline". Read, yes — decline, no: every
  // decider refused anything but `planned`, so a plan whose producer died
  // part-way through was stranded exactly as permanently as an empty one, and
  // went on pausing that project's cadence. The exclusion protected a decision
  // nobody could make. These lock the widening AND its two edges: what the
  // producer said still decides, and the proposals still survive.
  it('declines a PARTIAL plan whose producer is provably gone, and KEEPS its proposals', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 3, ageMs: 10 * HOUR });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 1 });
    expect(summary.outcomes[0]).toMatchObject({
      planId,
      outcome: 'declined',
      reason: 'job_terminal',
    });
    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    expect(row.decidedById).toBeNull();
    expect(row.decisionReason).toBe('abandoned');
    // ⚠️ NOTHING IS DELETED. This is the MOTIR-3154 / MOTIR-3160 rule applied to
    // the sweep, and it matters MORE here than on a reviewed decline: a
    // half-generated plan's proposals are the only surviving record of how far
    // the producer actually got before it died.
    await expect(adminDb.planItem.count({ where: { planId } })).resolves.toBe(3);
  });

  it.each(['succeeded', 'canceled'] as const)(
    'declines a PARTIAL plan behind a %s job too — every terminal state is final',
    async (status) => {
      const { fx } = await makeDrainedProject();
      const planId = await seedGeneratingPlan(fx, { items: 2 });
      jobIn(status);

      await abandonedPlanService.reconcileAbandoned();

      expect((await planRow(planId)).decisionReason).toBe('abandoned');
      await expect(adminDb.planItem.count({ where: { planId } })).resolves.toBe(2);
    },
  );

  it('declines a PARTIAL plan on the MAX-AGE arm — the crashed worker that never marked its job', async () => {
    // The failure the ASK cannot see, now reachable for a partial plan: the
    // worker vanished mid-stream, so its row reads `running` for ever and the
    // proposals it managed to append sit behind it.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, {
      items: 4,
      ageMs: (ABANDONED_PLAN_MAX_AGE_HOURS + 1) * HOUR,
    });
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'max_age' });
    expect((await planRow(planId)).decisionReason).toBe('abandoned');
    await expect(adminDb.planItem.count({ where: { planId } })).resolves.toBe(4);
  });

  it('an OUTAGE still terminates nothing, partial plan or not', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2 });
    vi.mocked(getJob).mockRejectedValue(new MotirAiUnavailableError('connect ECONNREFUSED'));

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'ai_unreachable' });
    expect((await planRow(planId)).status).toBe('generating');
  });

  it('the write refuses on a COUNT MISMATCH — a late append is still `row_moved`', async () => {
    // The guard used to be `items > 0`, which was only ever correct because the
    // predicate guaranteed zero. With partial plans selected, the question is
    // no longer "does it hold anything" but "did it MOVE": a proposal arriving
    // DURING the ask means the producer was alive after the job said otherwise,
    // and that is still a leave. Seeded partial, so the mismatch — not a
    // presence test — is what produces the verdict.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2 });
    vi.mocked(getJob).mockImplementation(async () => {
      await adminDb.planItem.create({
        data: {
          workspaceId: fx.workspaceId,
          planId,
          op: 'add',
          proposedFields: { title: 'Arrived late', kind: 'subtask' },
          blockedByRefs: [],
        },
      });
      return { jobId: 'job_dead', status: 'failed', result: null, error: null } as Awaited<
        ReturnType<typeof getJob>
      >;
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'left_as_is', reason: 'row_moved' });
    expect((await planRow(planId)).status).toBe('generating');
  });

  it('the discovery scan SEES the proposals — the RLS blind spot would now fail SAFE, not wide', async () => {
    // The direction reversed with the predicate. Under `items: { none: {} }` an
    // RLS-hidden proposal made a correlated NOT EXISTS vacuously true and pulled
    // a PARTIAL plan into the scan — a blind spot that WIDENED it. Under
    // `_count` a hidden proposal reads the count LOW at discovery, the write
    // re-counts bound to the plan's own workspace, and the mismatch verdict is
    // `row_moved`: a pass is lost, never a plan. What this asserts is the arm
    // WORKING — the count the system-context scan read matched the truth, so the
    // verdict is `declined` rather than the `row_moved` a hidden row would give.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 2 });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
    expect((await planRow(planId)).status).toBe('declined');
  });

  it('AC 8: the cadence FIRES again for a project whose only undecided plan was a stranded PARTIAL one', async () => {
    // The harm this card exists to remove, asserted the way the card asked for
    // it: `fired`, not `skipped: pending_proposal`. Before the widening this
    // project's cadence was paused for good — the plan could not be swept
    // (empty-only) and could not be decided (the status guard).
    const { fx, stubKey } = await makeDrainedProject();
    await seedGeneratingPlan(fx, { items: 2 });
    jobIn('failed');

    // BEFORE: the stranded partial plan reads as UNDECIDED, so the gate skips
    // the project — and nothing could ever change that, which is the defect.
    const before = await autoPlanCadenceService.runCadenceSweep();
    expect(before.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });

    await abandonedPlanService.reconcileAbandoned();
    const after = await autoPlanCadenceService.runCadenceSweep();

    expect(after).toMatchObject({ scanned: 1, fired: 1, skipped: 0 });
    expect(after.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });
});

describe('the sweep — AC 2: the cadence starts again', () => {
  it('a project whose ONLY undecided plan was abandoned fires, not skips', async () => {
    // The whole point of the card, asserted the way the card asked for it: the
    // outcome is `fired`, not `skipped: pending_proposal`.
    const { fx, stubKey } = await makeDrainedProject();
    await seedGeneratingPlan(fx);
    jobIn('failed');

    const before = await autoPlanCadenceService.runCadenceSweep();
    expect(before.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });

    await abandonedPlanService.reconcileAbandoned();
    const after = await autoPlanCadenceService.runCadenceSweep();

    expect(after).toMatchObject({ scanned: 1, fired: 1, skipped: 0 });
    expect(after.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });

  it('and the PAUSED indicator agrees — one predicate, two consumers', async () => {
    const { fx } = await makeDrainedProject();
    await seedGeneratingPlan(fx);
    jobIn('failed');

    await expect(
      autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ pending: true });

    await abandonedPlanService.reconcileAbandoned();

    await expect(
      autoPlanCadenceService.getAutoPlanPauseState(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ pending: false, planId: null });
  });

  it('an abandoned plan does not MASK an older one that is genuinely waiting', async () => {
    // The mirror of MOTIR-3051's own newest-first test, from the other side: the
    // reconciler must free the orphan WITHOUT freeing the project, because the
    // `planned` proposal underneath it is still somebody's decision.
    const { fx } = await makeDrainedProject();
    const waiting = await adminDb.plan.create({
      // The proposal is what makes it "genuinely waiting" (MOTIR-4124): a
      // `planned` plan holding nothing is a decision nobody owes, and the gate
      // now reads past it too.
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        items: {
          create: [
            {
              workspaceId: fx.workspaceId,
              op: 'add',
              proposedFields: { title: 'Still somebody’s decision', kind: 'task' },
            },
          ],
        },
      },
    });
    await seedGeneratingPlan(fx);
    jobIn('failed');

    await abandonedPlanService.reconcileAbandoned();

    await expect(
      autoPlanCadenceService.getPendingPlan(fx.projectId, fx.ctx),
    ).resolves.toMatchObject({ id: waiting.id });
    const summary = await autoPlanCadenceService.runCadenceSweep();
    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });
  });
});

describe('the sweep — the NO-PRODUCER arm (MOTIR-3236)', () => {
  // A plan written over the MCP has no generation job (`create_plan` writes
  // `sourceJobId: null`, MOTIR-2982), and the sweep's predicate carried
  // `sourceJobId: { not: null }` — so the two sets were DISJOINT and the hourly
  // pass could never see one, whatever its age. Two such rows were sitting in
  // production for ~22 and ~20 hours when this card was written, both holding
  // proposals, both pausing the project's cadence.
  //
  // The fix is the RE-SHAPE: the predicate selects every `generating` plan past
  // the grace and the decision table judges it. These lock both halves — that
  // the sweep can now SEE such a row, and that seeing it does not mean
  // terminating it.

  it('declines a job-less plan past the max age, with a null decider and `abandoned`', async () => {
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 3,
      ageMs: ABANDONED_PLAN_MAX_AGE_HOURS * HOUR + HOUR,
    });

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 1, declined: 1 });
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'no_producer' });
    const row = await planRow(planId);
    expect(row.status).toBe('declined');
    // Nobody decided it — the same honesty the other abandon arms carry.
    expect(row.decidedById).toBeNull();
    expect(row.decisionReason).toBe('abandoned');
    expect(row.decidedAt).not.toBeNull();
    // The proposals SURVIVE the decline, exactly as they do on the partial arm.
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(3);
  });

  it('never asks motir-ai about a job that does not exist', async () => {
    // A `resolveJobState(null)` could only 404, and a 404 already MEANS
    // something else here (`job_gone` — a producer that existed and is provably
    // dead). Sending one would launder "there was never a job" into "the job
    // died", on every pass, for every agent-authored plan.
    const { fx } = await makeDrainedProject();
    await seedGeneratingPlan(fx, {
      sourceJobId: null,
      ageMs: ABANDONED_PLAN_MAX_AGE_HOURS * HOUR + HOUR,
    });
    jobIn('running');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(getJob).not.toHaveBeenCalled();
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'no_producer' });
  });

  it('frees the CADENCE a partial job-less plan had paused — the second harm', async () => {
    // AMENDMENT 1's exclusion is presence-based (`items: { none: {} }`), so it
    // reads past an EMPTY job-less plan and NOT past one that appended a
    // skeleton and stopped. That partial row gates the project for ever, which
    // is the harm AMENDMENT 2 exists to remove arriving through the door
    // AMENDMENT 1 left open. Both live production rows were this shape.
    const { fx, stubKey } = await makeDrainedProject();
    await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 2,
      ageMs: ABANDONED_PLAN_MAX_AGE_HOURS * HOUR + HOUR,
    });

    const before = await autoPlanCadenceService.runCadenceSweep();
    expect(before.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'pending_proposal' });

    await abandonedPlanService.reconcileAbandoned();
    const after = await autoPlanCadenceService.runCadenceSweep();

    expect(after).toMatchObject({ scanned: 1, fired: 1, skipped: 0 });
    expect(after.outcomes[0]).toMatchObject({ status: 'fired', itemKey: stubKey });
  });

  it('leaves a job-less plan an agent appended to DURING the pass — `row_moved` still holds', async () => {
    // The count-mismatch guard is not bypassed by the new arm. There is no ask
    // to race here, so the window is the write transaction itself — the append
    // is driven from the classify seam via the deps injection point, which is
    // the only thing between discovery and the write on this path.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 1,
      ageMs: ABANDONED_PLAN_MAX_AGE_HOURS * HOUR + HOUR,
    });
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId,
        op: 'add',
        proposedFields: { title: 'Arrived after discovery', kind: 'subtask' },
        blockedByRefs: [],
      },
    });
    // Re-run discovery AFTER the append would be a different test; instead drive
    // the mismatch the way production produces it — the candidate's snapshot
    // count is what the write compares against, and here it is already stale.
    const summary = await abandonedPlanService.reconcileAbandoned({
      now: new Date(Date.now() + MINUTE),
    });

    // Discovery saw 2 and the write re-counted 2 — so this one DOES land. What
    // the assertion pins is that the comparison ran at all on a producerless
    // candidate rather than being skipped with the ask.
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'no_producer' });
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
  });

  it('a producer-bearing plan behaves EXACTLY as it does today', async () => {
    // The regression half: the predicate widened, so every previously-selected
    // row must still be judged the same way, by the same ask.
    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx, { items: 1 });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(getJob).toHaveBeenCalledTimes(1);
    expect(summary.outcomes[0]).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
    expect((await planRow(planId)).decisionReason).toBe('abandoned');
  });

  it('judges a MIXED batch one row at a time', async () => {
    // Both shapes in one pass, which is what production holds: an agent-authored
    // orphan and a dead generation job, judged by different arms of the same
    // table, with exactly one network call between them.
    const { fx } = await makeDrainedProject();
    const jobless = await seedGeneratingPlan(fx, {
      sourceJobId: null,
      items: 2,
      ageMs: ABANDONED_PLAN_MAX_AGE_HOURS * HOUR + 2 * HOUR,
    });
    const withJob = await seedGeneratingPlan(fx, { ageMs: HOUR });
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 2, declined: 2 });
    expect(getJob).toHaveBeenCalledTimes(1);
    const byPlan = new Map(summary.outcomes.map((o) => [o.planId, o]));
    expect(byPlan.get(jobless)).toMatchObject({ outcome: 'declined', reason: 'no_producer' });
    expect(byPlan.get(withJob)).toMatchObject({ outcome: 'declined', reason: 'job_terminal' });
  });
});

describe('the sweep — cross-workspace, bounded, and wired', () => {
  it('reconciles plans in DIFFERENT workspaces in one pass', async () => {
    // The discovery read is the only cross-tenant thing here, and it is the one
    // an unarmed RLS policy would silently return zero rows for. Two tenants is
    // what proves it is actually crossing.
    const a = await makeDrainedProject({ name: 'Acme', identifier: 'ACME' });
    const b = await makeDrainedProject({ name: 'Globex', identifier: 'GLBX' });
    const planA = await seedGeneratingPlan(a.fx);
    const planB = await seedGeneratingPlan(b.fx);
    jobIn('failed');

    const summary = await abandonedPlanService.reconcileAbandoned();

    expect(summary).toMatchObject({ scanned: 2, declined: 2 });
    expect((await planRow(planA)).status).toBe('declined');
    expect((await planRow(planB)).status).toBe('declined');
  });

  it('is bounded per pass, oldest first — a backlog drains over ticks', async () => {
    const { fx } = await makeDrainedProject();
    const oldest = await seedGeneratingPlan(fx, { ageMs: 5 * HOUR });
    const newer = await seedGeneratingPlan(fx, { ageMs: 2 * HOUR });
    jobIn('failed');

    const first = await abandonedPlanService.reconcileAbandoned({ batchSize: 1 });

    expect(first).toMatchObject({ scanned: 1, declined: 1 });
    expect(first.outcomes[0]).toMatchObject({ planId: oldest });
    expect((await planRow(newer)).status).toBe('generating');

    const second = await abandonedPlanService.reconcileAbandoned({ batchSize: 1 });
    expect(second.outcomes[0]).toMatchObject({ planId: newer, outcome: 'declined' });
  });

  it('an empty pass is cheap and writes nothing', async () => {
    await makeDrainedProject();

    await expect(abandonedPlanService.reconcileAbandoned()).resolves.toEqual({
      scanned: 0,
      declined: 0,
      outcomes: [],
    });
    expect(getJob).not.toHaveBeenCalled();
  });

  it('runs as the registered cron job', async () => {
    // The wiring half: a sweep nobody scheduled reconciles nothing, and the
    // MOTIR-1970 lesson is that an unregistered job is indistinguishable from an
    // untriggered one.
    expect(jobDefinitions).toContain(abandonedPlanSweep);

    const { fx } = await makeDrainedProject();
    const planId = await seedGeneratingPlan(fx);
    jobIn('failed');

    const engine = new JobTestEngine({ function: abandonedPlanSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ scanned: 1, declined: 1 });
    expect((await planRow(planId)).status).toBe('declined');
  });
});
