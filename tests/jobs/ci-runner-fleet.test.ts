import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { jobFunctions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { jobSchedules } from '@/lib/jobs/schedules';
import { RETRY_POLICIES } from '@/lib/jobs/retries';
import {
  ciRunnerBootService,
  pollWaitMs,
  FLEET_TIME_BUDGETS,
} from '@/lib/services/ciRunnerBootService';
import { maxDuration } from '@/app/api/inngest/route';
import { ciRunnerBootEvent } from '@/lib/ciFleet/bootDispatch';
import { jobRunsService } from '@/lib/services/jobRunsService';
import {
  CI_RUNNER_PROVISION_SWEEP_CRON,
  CI_RUNNER_REAP_CRON,
  ciRunnerBoot,
  ciRunnerProvisionSweep,
  ciRunnerReap,
} from '@/lib/jobs/definitions/ciRunnerFleet';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken, randomInt } from '../helpers/random';

// The runner FLEET's job WIRING (Story MOTIR-1916 · MOTIR-1921).
//
// `ciRunnerBootService.test.ts` drives the provisioner itself against real
// Postgres. This file covers what that suite cannot reach: whether the three
// functions are actually SERVED, on what schedule, with which retry budget, and
// whether the handlers delegate rather than re-implement.
//
// ⚠️ AN UNREGISTERED CRON FIRES SILENTLY NEVER — no error, no ledger row, nothing
// to alert on. For a fleet whose reaper is the last thing standing between Motir
// and an unbounded invoice, "the job exists" and "the job runs" are different
// claims, and only the second one is worth anything.

/** Read a job's Inngest config by re-defining it and catching the call. */
function configFor(options: Parameters<typeof defineJob>[0]) {
  const spy = vi.spyOn(inngest, 'createFunction');
  try {
    defineJob(options, () => undefined);
    return spy.mock.calls.at(-1)?.[0] as
      | { triggers?: Array<{ cron?: string; event?: string }>; retries?: number }
      | undefined;
  } finally {
    spy.mockRestore();
  }
}

/**
 * The triggering event's id, PINNED.
 *
 * ⚠️ `InngestTestEngine` does not model event identity the way the executor
 * does, and the difference is load-bearing here. `individualExecution` mints a
 * fresh `runId` per replay pass and merges a fresh `createMockEvent()` UNDER
 * each supplied event, so an event handed in without an id is given a NEW one on
 * every pass. In production the id is assigned once, when the event is sent, and
 * every pass of the run sees the same one. The boot's supervision memo keys on
 * exactly that id (MOTIR-2002), so an unpinned event here would exercise a world
 * that does not exist — and would do it by failing, not by passing.
 */
const EVENT_ID = 'evt-ci-runner-boot-1';

/** The event both senders emit, from the REAL payload builder, with the id the
 *  executor would have assigned. */
function bootEvent(intentId: string, id: string = EVENT_ID) {
  return { ...ciRunnerBootEvent(intentId), id };
}

/** A settled run's outcome — a container that ran, with its cost. The shape
 *  MOTIR-1928 reads off both the ledger and Inngest's own run output. */
const SETTLED_OUTCOME = {
  outcome: 'settled',
  reason: 'job_completed',
  containerId: 'c-1',
  billableSeconds: 42,
  costUsd: '0.0042',
  bootLatencyMs: 1200,
  usage: {
    handleId: 'c-1',
    provider: 'fake',
    region: 'ams',
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: 'moooon-B-V/motir-core',
    workload: 'ci_runner',
    workflowJobId: 99,
    cpuKind: 'shared',
    cpus: 2,
    memoryMb: 4096,
    createdAt: new Date('2026-08-02T10:00:00.000Z'),
    startedAt: new Date('2026-08-02T10:00:05.000Z'),
    stoppedAt: new Date('2026-08-02T10:00:47.000Z'),
    billableSeconds: 42,
    usdPerSecond: '0.0001',
    costUsd: '0.0042',
    rateEffectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    terminalState: 'stopped',
    teardownReason: 'job_completed',
  },
} as const;

/** What `defineJob` persists to `job_run.output`, and what a replayed pass
 *  returns: the JSON projection, Dates and all. */
const SETTLED_JSON = JSON.parse(JSON.stringify(SETTLED_OUTCOME)) as unknown;

/** One real, pending intent — the row the supervision memo is written to. The
 *  boot's `runIntent` is spied out in this file (the provisioner itself is
 *  driven end to end by `tests/ciFleet/ciRunnerBootService.test.ts`), so the row
 *  needs only its tenancy to be real. */
let intentId: string;

async function seedIntent(): Promise<string> {
  const email = `fleet-jobs-${randomToken(6)}@example.com`;
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${email}`,
    ownerUserId: user.id,
  });
  const intent = await db.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(44000 + randomInt(900)),
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      requestedLabels: ['motir-runner'],
      queuedAt: new Date(Date.now() - 5_000),
    },
  });
  return intent.id;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
  await truncateAuthTables();
  intentId = await seedIntent();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('all three fleet jobs are REGISTERED and reach the service through the injected bag', () => {
  it('the sweep, the boot and the reaper are all served', () => {
    expect(jobFunctions).toContain(ciRunnerProvisionSweep);
    expect(jobFunctions).toContain(ciRunnerBoot);
    expect(jobFunctions).toContain(ciRunnerReap);
  });

  it('the service in the bag IS the exported singleton, not a lookalike', () => {
    expect(jobServices.ciRunnerBoot).toBe(ciRunnerBootService);
  });

  it('both crons self-register in the schedule table', () => {
    // The table the schedule-health check iterates (MOTIR-1970). A cron missing
    // from it is a cron nothing is watching.
    const ids = jobSchedules().map((s) => s.functionId);
    expect(ids).toContain('system.ci-runner-provision-sweep');
    expect(ids).toContain('system.ci-runner-reap');
  });
});

describe('the schedules say what they can and cannot promise', () => {
  it('the provision sweep runs every minute — the floor, and an honest one (§6)', () => {
    // §6 budgets p50 ≤ 30s webhook-to-start. A minute-granularity cron CANNOT
    // meet that, which is why the sweep is documented as the interim trigger and
    // MOTIR-1922's gate owns the hot path.
    expect(CI_RUNNER_PROVISION_SWEEP_CRON).toBe('* * * * *');
    const config = configFor({
      id: 'system.ci-runner-provision-sweep',
      cron: CI_RUNNER_PROVISION_SWEEP_CRON,
      retryPolicy: 'idempotent',
    });
    expect(config?.triggers).toEqual([{ cron: '* * * * *' }]);
  });

  it('the reaper runs every 10 minutes, clear of the top of the hour', () => {
    // The window between an orphan appearing and being destroyed is BILLED, so
    // the reaper runs often; offsetting it off :00 keeps it clear of the other
    // `system.*` schedules.
    const minuteField = CI_RUNNER_REAP_CRON.split(' ')[0]!;
    expect(minuteField.split(',')).toHaveLength(6);
    expect(minuteField.split(',')).not.toContain('0');
  });
});

describe('the retry budgets are correctness decisions, not defaults', () => {
  it('the BOOT takes ONE attempt — a retry would boot a second container', () => {
    // ⚠️ The one retry policy in the fleet that is a correctness decision. A
    // retry mints a SECOND JIT config and boots a SECOND container for a job only
    // one runner can take; the loser idles to its timeout, billed to the tenant,
    // having done nothing. `runIntent` returns typed outcomes instead of throwing
    // precisely so the retryable failures come back through the sweep for free.
    const config = configFor({ id: 'system.ci-runner-boot', retryPolicy: 'none' });
    expect(config?.retries).toBe(RETRY_POLICIES.none.maxAttempts - 1);
    expect(config?.retries).toBe(0);
  });

  it('the sweep and the reaper are IDEMPOTENT — both re-derive rather than re-assert', () => {
    const sweep = configFor({
      id: 'system.ci-runner-provision-sweep',
      cron: CI_RUNNER_PROVISION_SWEEP_CRON,
      retryPolicy: 'idempotent',
    });
    const reap = configFor({
      id: 'system.ci-runner-reap',
      cron: CI_RUNNER_REAP_CRON,
      retryPolicy: 'idempotent',
    });
    expect(sweep?.retries).toBe(RETRY_POLICIES.idempotent.maxAttempts - 1);
    expect(reap?.retries).toBe(RETRY_POLICIES.idempotent.maxAttempts - 1);
  });
});

describe('the sweep fans out ONE event per intent', () => {
  it('sends one boot event per pending intent, carrying only the id', async () => {
    // One event per intent, never one per batch: a batch handler that died
    // halfway would leave the containers it had already booted with no
    // supervisor — the exact orphan the reaper exists to catch, manufactured on
    // purpose.
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue(['i1', 'i2']);
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });

    const engine = new InngestTestEngine({ function: ciRunnerProvisionSweep });
    const { result } = await engine.execute();

    expect(result).toEqual({ dispatched: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    // The literal, spelled out rather than compared to `ciRunnerBootEvent('i1')`
    // — this is the one place that pins the payload independently of the builder
    // that produces it. `workspaceId` is `null`, never `''`: an empty string is
    // not nullish, so it survives `defineJob`'s `?? null` and trips the ledger's
    // workspace FK, which silently costs the run its `job_run` row (MOTIR-1998).
    expect(send.mock.calls[0]![0]).toEqual({
      name: 'system.ci-runner-boot',
      data: { intentId: 'i1', workspaceId: null },
    });
  });

  it('dispatches nothing — and sends nothing — when no intent is pending', async () => {
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue([]);
    const send = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });

    const engine = new InngestTestEngine({ function: ciRunnerProvisionSweep });
    const { result } = await engine.execute();

    expect(result).toEqual({ dispatched: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('LOGS when the batch ceiling binds — never a silent truncation', async () => {
    // A sweep that silently drops the tail reads exactly like one that had
    // nothing left to do.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(ciRunnerBootService, 'listRunnableIntentIds').mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => `i${i}`),
    );
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] });

    const engine = new InngestTestEngine({ function: ciRunnerProvisionSweep });
    await engine.execute();

    expect(warn).toHaveBeenCalledWith(
      '[ciRunnerProvisionSweep] the batch ceiling bound; more intents remain',
      { batch: 25 },
    );
  });
});

describe('the boot and reap handlers DELEGATE', () => {
  it('the boot handler DELEGATES each phase to the service, and returns the settled outcome', async () => {
    const boot = vi
      .spyOn(ciRunnerBootService, 'bootIntent')
      .mockResolvedValue({ phase: 'terminal', outcome: { outcome: 'unknown_intent' } });
    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    // Driven with the REAL payload builder, so the handler is exercised against
    // the event the two senders actually emit rather than a hand-written double.
    const { result } = await engine.execute({ events: [bootEvent('i-42')] });

    // The handler DELEGATES: an intent id off the payload, nothing
    // re-implemented here. A `terminal` boot provisioned nothing, so there is
    // nothing to supervise or tear down and the outcome IS the run's result.
    expect(boot.mock.calls.every((c) => c[0] === 'i-42')).toBe(true);
    expect(result).toEqual({ outcome: 'unknown_intent' });
  });

  it('the boot handler NEVER calls runIntent — that would rebuild the hour-long invocation', async () => {
    // ⚠️ THE REGRESSION GUARD (MOTIR-2007). `runIntent` still exists as the
    // in-process composition the service suites drive, and it still supervises
    // to the end in ONE call — which is exactly the shape that could not fit
    // inside `maxDuration`. A handler reaching for it would silently restore the
    // defect while every other test kept passing.
    const runIntent = vi.spyOn(ciRunnerBootService, 'runIntent');
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'terminal',
      outcome: { outcome: 'unknown_intent' },
    });

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)] });

    expect(runIntent).not.toHaveBeenCalled();
  });

  it('the reaper handler delegates and returns the sweep counts', async () => {
    const reap = vi
      .spyOn(ciRunnerBootService, 'reapOrphans')
      .mockResolvedValue({ reaped: 2, staleClaims: 1, usages: [] });

    const engine = new InngestTestEngine({ function: ciRunnerReap });
    const { result } = await engine.execute();

    expect(reap).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ reaped: 2, staleClaims: 1, usages: [] });
  });

  it('the reaper runs end to end against a real (empty) database', async () => {
    // No spy: the REAL service runs. With no orchestrator configured it is inert,
    // which is the assertion — a self-hosted deployment must not error every ten
    // minutes for want of a Fly token.
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    vi.stubEnv('FLY_FLEET_API_TOKEN', '');
    vi.stubEnv('FLY_FLEET_APP', '');
    vi.stubEnv('MOTIR_RUNNER_IMAGE', '');
    try {
      const engine = new InngestTestEngine({ function: ciRunnerReap });
      const { result } = await engine.execute();
      expect(result).toEqual({ reaped: 0, staleClaims: 0, usages: [] });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a reaper run lands one succeeded, UNTENANTED ledger row', async () => {
    vi.spyOn(ciRunnerBootService, 'reapOrphans').mockResolvedValue({
      reaped: 0,
      staleClaims: 0,
      usages: [],
    });

    const engine = new InngestTestEngine({ function: ciRunnerReap });
    await engine.execute();

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      functionId: 'system.ci-runner-reap',
      eventName: 'scheduled.system.ci-runner-reap',
      status: 'succeeded',
      workspaceId: null,
      failure: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOTIR-1998 — the BOOT's ledger row.
//
// The boot is the one job in the system that spends real money per invocation,
// and until this card it wrote NO `job_run` row at all: the event carried
// `workspaceId: ''`, which is not nullish, so it survived `defineJob`'s
// `?? null`, reached `job_run.workspace_id`, tripped the workspace FK (`P2003`)
// and was swallowed by `isVanishedRunError` — the catch that exists for a
// genuinely vanished tenant (MOTIR-1545). No start, no outcome, no duration,
// nothing for MOTIR-1928's live verification to read.
//
// So these assert the ROW, read back out of real Postgres. Asserting the send
// (what the earlier suites do, correctly, for the fan-out) cannot see this bug:
// the event went out perfectly every time.
// ─────────────────────────────────────────────────────────────────────────────
describe('a BOOT run is READABLE on the job_run ledger', () => {
  it('lands EXACTLY ONE succeeded, untenanted row for the event both senders emit', async () => {
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'terminal',
      outcome: { outcome: 'unknown_intent' },
    });

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    // The REAL payload builder — the whole defect lived in the payload, so a
    // hand-written event here would test the fix out of existence.
    await engine.execute({ events: [bootEvent(intentId)] });

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      functionId: 'system.ci-runner-boot',
      eventName: 'system.ci-runner-boot',
      status: 'succeeded',
      // Untenanted — the fleet is cross-tenant, exactly like the reaper above.
      // This is the assertion that was `0 rows` before MOTIR-1998.
      workspaceId: null,
      failure: null,
    });
  });

  it("carries the run's OUTCOME as the row's output, so a settled run is readable end to end", async () => {
    // The audit trail `ciRunnerFleet.ts` promises: the container's id, its
    // billable seconds and its cost, on the ledger, for a post-incident read.
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    vi.spyOn(ciRunnerBootService, 'settleSupervision').mockResolvedValue(SETTLED_OUTCOME);

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)], steps: sleepSteps(10) });

    const run = await db.jobRun.findFirstOrThrow();
    expect(run.status).toBe('succeeded');
    // `defineJob` JSON-round-trips the handler's return value into `output`, so
    // the Dates land as ISO strings — assert the persisted shape, not the
    // in-memory one.
    expect(run.output).toEqual(SETTLED_JSON);
    const output = run.output as { billableSeconds: number; costUsd: string; containerId: string };
    expect(output.billableSeconds).toBe(42);
    expect(output.costUsd).toBe('0.0042');
    expect(output.containerId).toBe('c-1');
  });

  it("an EMPTY-STRING workspaceId writes no row at all — the failure mode, pinned so it can't come back quietly", async () => {
    // Characterization, not aspiration: this is what `''` DOES, and why the
    // payload's type is `null` rather than `string`. `recordStart` returning
    // `null` is the P2003 catch doing its job for a tenant that really is gone
    // (MOTIR-1545) — the bug was feeding it a value that is never a tenant.
    const started = await jobRunsService.recordStart({
      workspaceId: '',
      functionId: 'system.ci-runner-boot',
      eventName: 'system.ci-runner-boot',
      eventId: 'evt-empty',
      attempt: 0,
    });
    expect(started).toBeNull();
    expect(await db.jobRun.count({ where: { eventId: 'evt-empty' } })).toBe(0);

    // The identical call with `null` — the shipped value — persists.
    const untenanted = await jobRunsService.recordStart({
      workspaceId: null,
      functionId: 'system.ci-runner-boot',
      eventName: 'system.ci-runner-boot',
      eventId: 'evt-null',
      attempt: 0,
    });
    expect(untenanted).not.toBeNull();
    expect(await db.jobRun.count({ where: { eventId: 'evt-null' } })).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOTIR-2007 — THE DURABLE POLL LOOP: a CI job may outlive the invocation that
// supervises it.
//
// The defect: supervision watched a container synchronously for up to 3,600s
// inside ONE invocation whose ceiling is `maxDuration = 300`. Every CI job over
// ~5 minutes was killed mid-loop — no teardown, no usage row, a dead-lettered
// run for a job that had passed, and an intent holding a fleet slot against the
// fail-CLOSED ceiling until the reaper aged it out 70 minutes later.
//
// So the assertion is not "supervision works" — it is that a run whose SLEEPS
// ALREADY SUM PAST `maxDuration` still reaches its teardown step. Driven through
// `InngestTestEngine` across the real step boundaries, never by shortening the
// deadline until it fits inside one invocation.
//
// ⚠️ `step.sleep` HANGS `InngestTestEngine` UNLESS ITS STATE IS SUPPLIED. The
// engine only records state for steps that RAN, and a sleep never "runs" — so an
// un-stubbed sleep is re-found forever and `execute()` never resolves (it fails
// as a test TIMEOUT, which reads like a slow test rather than a missing stub).
// `sleepSteps()` pre-fulfils them; supply more than the loop can use.
// ─────────────────────────────────────────────────────────────────────────────

/** Pre-fulfilled `step.sleep` state, so the engine can cross the boundaries. */
function sleepSteps(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `supervise-wait:${i + 1}`,
    handler: () => null,
  }));
}

/** A supervising session — the JSON shape `bootIntent` hands across the step
 *  boundary. Only the fields the loop and the teardown read need to be real. */
const SESSION = {
  intentId: 'i-long',
  handle: {
    provider: 'fake' as const,
    id: 'c-1',
    region: 'ams',
    createdAt: '2026-08-02T10:00:00.000Z',
  },
  githubRunnerId: 9001,
  bootedAt: '2026-08-02T10:00:00.000Z',
  queuedAt: '2026-08-02T09:59:55.000Z',
  attribution: {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    repoFullName: 'moooon-B-V/motir-core',
    workload: 'ci_runner',
    workflowJobId: 99,
  },
};

const NOT_DONE = {
  done: false as const,
  startedAt: '2026-08-02T10:00:05.000Z',
  bootLatencyMs: 1200,
  consecutiveReadFailures: 0,
};

describe('a container that OUTLIVES the invocation ceiling still reaches teardown', () => {
  /** How many polls it takes for the loop's own sleeps to sum past `maxDuration`. */
  function pollsToOutliveTheCeiling(): number {
    let elapsed = 0;
    let polls = 0;
    while (elapsed <= maxDuration * 1000) {
      polls += 1;
      elapsed += pollWaitMs(polls);
    }
    return polls;
  }

  it('supervises PAST maxDuration across many steps, then settles — the whole defect, inverted', async () => {
    const polls = pollsToOutliveTheCeiling();
    // Sanity on the premise: this really is longer than one invocation may live.
    const scheduled = Array.from({ length: polls }, (_, i) => pollWaitMs(i + 1)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(scheduled).toBeGreaterThan(maxDuration * 1000);

    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    // Not terminal until the very last poll — a container that ran for longer
    // than the supervisor's own invocation could possibly have lasted.
    const poll = vi.spyOn(ciRunnerBootService, 'pollOnce');
    for (let i = 1; i < polls; i += 1) poll.mockResolvedValueOnce(NOT_DONE);
    poll.mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    const settle = vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue(SETTLED_OUTCOME);

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({
      events: [bootEvent(intentId)],
      steps: sleepSteps(polls + 5),
    });

    // ⚠️ TEARDOWN RAN. This is the line the card exists for: before it, the
    // supervising invocation was killed here and `settleIntent` /
    // `recordContainerUsage` / `deregisterQuietly` never happened at all.
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![1]).toMatchObject({ done: true, reason: 'job_completed' });
    // It really did cross many boundaries rather than collapsing into one poll.
    expect(poll.mock.calls.length).toBe(polls);
    // And the run REPORTS the settled outcome — no dead-letter, no
    // `FUNCTION_INVOCATION_TIMEOUT` for a job that succeeded. Compared through
    // the JSON projection because that is what BOTH surfaces apply: Inngest
    // serializes the function's return value, and `defineJob` round-trips the
    // same value into `job_run.output`. The in-process engine hands back the
    // live object, Dates and all, so projecting here is what makes the
    // assertion about production rather than about the harness.
    expect(JSON.parse(JSON.stringify(result))).toEqual(SETTLED_JSON);
  }, 30_000);

  it('the ledger row reads SUCCEEDED with the settled outcome, not a platform kill', async () => {
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValueOnce(NOT_DONE).mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    vi.spyOn(ciRunnerBootService, 'settleSupervision').mockResolvedValue(SETTLED_OUTCOME);

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)], steps: sleepSteps(10) });

    const run = await db.jobRun.findFirstOrThrow();
    expect(run.status).toBe('succeeded');
    // The audit trail MOTIR-1928 reads on live infrastructure: the container's
    // id, its billable seconds and its cost — for a job that used to
    // dead-letter with no step output at all.
    expect(run.output).toEqual(SETTLED_JSON);
  });

  it('EVERY phase runs exactly once across the whole run — memoization, not a memo column', async () => {
    // ⚠️ WHAT RETIRES MOTIR-2002. Its `supervision_key` / `supervision_outcome`
    // columns existed only because the supervision sat OUTSIDE a step and so
    // re-executed on every durable-replay pass. With each phase inside a step,
    // Inngest's memoization gives once-per-run for free — including the
    // admission claim inside `bootIntent`, which is the one that costs money.
    const boot = vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'supervising',
      session: SESSION,
    });
    vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValue({
      done: true,
      reason: 'job_completed',
      startedAt: NOT_DONE.startedAt,
      bootLatencyMs: NOT_DONE.bootLatencyMs,
      failureDetail: null,
    });
    const settle = vi
      .spyOn(ciRunnerBootService, 'settleSupervision')
      .mockResolvedValue(SETTLED_OUTCOME);

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({
      events: [bootEvent(intentId)],
      steps: sleepSteps(10),
    });

    expect(boot).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    // Both surfaces agree — what MOTIR-2002 was restoring by other means, now a
    // property of the shape. Through the JSON projection both of them apply.
    const ledger = await db.jobRun.findFirstOrThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(SETTLED_JSON);
    expect(ledger.output).toEqual(JSON.parse(JSON.stringify(result)));
  });

  it('the static iteration CEILING still tears down — the loop cannot exit any other way', async () => {
    // ⚠️ THE BACKSTOP ON THE BACKSTOP. `pollOnce` normally ends the loop on the
    // job timeout, but that is a CLOCK decision; this ceiling holds if the clock
    // does something surprising (a frozen `now`, a provider that never reports
    // terminal). A durable loop with no static bound is a runaway that bills per
    // iteration — and, worse, one that exits without teardown.
    const ceiling = FLEET_TIME_BUDGETS.maxPollIterations;
    Object.defineProperty(FLEET_TIME_BUDGETS, 'maxPollIterations', {
      value: 3,
      configurable: true,
    });
    try {
      vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
        phase: 'supervising',
        session: SESSION,
      });
      // NEVER terminal — the pathological case the ceiling exists for.
      const poll = vi.spyOn(ciRunnerBootService, 'pollOnce').mockResolvedValue(NOT_DONE);
      const settle = vi
        .spyOn(ciRunnerBootService, 'settleSupervision')
        .mockResolvedValue(SETTLED_OUTCOME);

      const engine = new InngestTestEngine({ function: ciRunnerBoot });
      await engine.execute({ events: [bootEvent(intentId)], steps: sleepSteps(10) });

      expect(poll).toHaveBeenCalledTimes(3);
      // The container is still torn down, with a verdict that SAYS why rather
      // than reporting a clean completion it never observed.
      expect(settle).toHaveBeenCalledTimes(1);
      expect(settle.mock.calls[0]![1]).toMatchObject({
        done: true,
        reason: 'job_timed_out',
        failureDetail: expect.stringContaining('poll ceiling'),
      });
    } finally {
      Object.defineProperty(FLEET_TIME_BUDGETS, 'maxPollIterations', {
        value: ceiling,
        configurable: true,
      });
    }
  });

  it('a boot that provisioned NOTHING never polls and never tears down', async () => {
    // No container means nothing to supervise. The run ends at the boot step —
    // and must not schedule a teardown for a container that does not exist.
    vi.spyOn(ciRunnerBootService, 'bootIntent').mockResolvedValue({
      phase: 'terminal',
      outcome: { outcome: 'gate_deferred', reason: 'project_cap', detail: 'at the cap' },
    });
    const poll = vi.spyOn(ciRunnerBootService, 'pollOnce');
    const settle = vi.spyOn(ciRunnerBootService, 'settleSupervision');

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({ events: [bootEvent(intentId)] });

    expect(poll).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: 'gate_deferred',
      reason: 'project_cap',
      detail: 'at the cap',
    });
  });
});
