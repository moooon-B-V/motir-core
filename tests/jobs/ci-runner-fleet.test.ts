import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { jobFunctions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { jobSchedules } from '@/lib/jobs/schedules';
import { RETRY_POLICIES } from '@/lib/jobs/retries';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
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
  const email = `fleet-jobs-${Math.random().toString(36).slice(2, 8)}@example.com`;
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
      jobId: String(44000 + Math.floor(Math.random() * 900)),
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
  it("the boot handler passes the event's intent id and its dispatch key to the service", async () => {
    const outcome = { outcome: 'unknown_intent' } as const;
    const supervise = vi.spyOn(ciRunnerBootService, 'superviseOnce').mockResolvedValue(outcome);
    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    // Driven with the REAL payload builder, so the handler is exercised against
    // the event the two senders actually emit rather than a hand-written double.
    const { result } = await engine.execute({ events: [bootEvent('i-42')] });

    // The handler DELEGATES: an intent id off the payload and the dispatch key
    // off the event, nothing re-implemented here. Every call carries the SAME
    // key — that is what lets `superviseOnce` recognise a replay of this dispatch
    // rather than a second one (MOTIR-2002).
    expect(new Set(supervise.mock.calls.map((c) => c[1]))).toEqual(new Set([EVENT_ID]));
    expect(supervise.mock.calls.every((c) => c[0] === 'i-42')).toBe(true);
    expect(result).toEqual(outcome);
  });

  it('falls back to the RUN id when the event carries no id — the key is never undefined', async () => {
    // The boot is only ever event-triggered, so in production the id is always
    // there; the fallback mirrors `defineJob`'s own (`event.id ?? ctx.runId`, for
    // the cron and harness events that carry none). It is asserted because a key
    // that could arrive `undefined` would silently memoize every dispatch under
    // one bucket — the failure mode is a run inheriting another run's outcome,
    // which is exactly what the key exists to prevent.
    const supervise = vi
      .spyOn(ciRunnerBootService, 'superviseOnce')
      .mockResolvedValue({ outcome: 'unknown_intent' });

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [{ ...ciRunnerBootEvent('i-42'), id: undefined }] });

    expect(supervise).toHaveBeenCalled();
    for (const [, key] of supervise.mock.calls) {
      expect(typeof key).toBe('string');
      expect(key).not.toBe('');
    }
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
    vi.spyOn(ciRunnerBootService, 'runIntent').mockResolvedValue({ outcome: 'unknown_intent' });

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
    vi.spyOn(ciRunnerBootService, 'runIntent').mockResolvedValue(SETTLED_OUTCOME);

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)] });

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
// MOTIR-2002 — the supervision runs ONCE PER DISPATCH.
//
// `runIntent` sits OUTSIDE any `step.run` — it has to, because one step cannot
// outlive one invocation of the serve route (`maxDuration = 300`) and a
// supervised CI job is allowed 3,600s. Inngest re-invokes a handler from the top
// at every step boundary, so un-stepped code ran once per PASS, and the number of
// passes tracked how many ledger steps `defineJob` happened to write: the
// MOTIR-1998 fix, by restoring the `job-run:succeeded` step, took the count from
// one to two. Nothing booted twice — the atomic claim inside `admit` is what the
// replay's call lost — but the fleet's money safety rested on that claim ALONE,
// every boot took the fleet-wide admission lock twice, and Inngest reported the
// LOSER's `already_claimed` as the run's outcome for a run that had settled a
// container.
//
// So the count is the assertion here, not an incidental, and it is asserted
// under BOTH ledger topologies — the whole point is that it no longer tracks
// them.
// ─────────────────────────────────────────────────────────────────────────────
describe('the SUPERVISION runs once per DISPATCH, not once per replay pass', () => {
  it('invokes runIntent EXACTLY ONCE for a run that writes both ledger steps', async () => {
    const run = vi.spyOn(ciRunnerBootService, 'runIntent').mockResolvedValue(SETTLED_OUTCOME);

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    await engine.execute({ events: [bootEvent(intentId)] });

    // The two-step topology, asserted rather than assumed: `job-run:start` AND
    // `job-run:succeeded` both ran, which is what a `succeeded` row with an
    // output IS — and which is the topology that used to make it two calls.
    const ledger = await db.jobRun.findFirstOrThrow();
    expect(ledger.status).toBe('succeeded');
    expect(ledger.output).toEqual(SETTLED_JSON);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.map((c) => c[0])).toEqual([intentId]);
  });

  it('...and exactly once for a run that writes NO ledger row — the count does not track the step topology', async () => {
    const run = vi.spyOn(ciRunnerBootService, 'runIntent').mockResolvedValue(SETTLED_OUTCOME);

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    // The pre-MOTIR-1998 payload, used here for what it does to the TOPOLOGY: an
    // empty-string workspaceId makes `recordStart` return null, so there is no
    // `job-run:succeeded` step and the run takes one fewer pass. Same count.
    await engine.execute({
      events: [
        { name: 'system.ci-runner-boot', data: { intentId, workspaceId: '' }, id: EVENT_ID },
      ],
    });

    expect(await db.jobRun.count()).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the run's reported outcome is the SETTLED one, and the ledger row agrees with it", async () => {
    // The spy's SECOND answer is exactly what a live replay used to produce: the
    // claim is already taken, so `admit` returns `already_claimed` having spent
    // nothing — and that was the value Inngest reported for a run that had
    // settled a container. It must now never be reached.
    const run = vi
      .spyOn(ciRunnerBootService, 'runIntent')
      .mockResolvedValueOnce(SETTLED_OUTCOME)
      .mockResolvedValue({ outcome: 'already_claimed' });

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({ events: [bootEvent(intentId)] });

    expect(run).toHaveBeenCalledTimes(1);
    const ledger = await db.jobRun.findFirstOrThrow();
    // Both surfaces, the same value — the disagreement MOTIR-1928 reads across
    // is gone. A replayed pass returns the JSON projection the ledger stores, so
    // this is one comparison, not two that happen to look alike.
    expect(result).toEqual(SETTLED_JSON);
    expect(ledger.output).toEqual(result);
  });

  it('a SECOND dispatch for the same intent gets its OWN answer, never the first one’s container', async () => {
    // The memo is scoped to the dispatch that wrote it. The sweep and the
    // webhook race by design (`claimPending` decides the winner), and the loser
    // must report `already_claimed` — reporting a settled container it never
    // booted would be the old lie pointing the other way.
    const run = vi
      .spyOn(ciRunnerBootService, 'runIntent')
      .mockResolvedValueOnce(SETTLED_OUTCOME)
      .mockResolvedValue({ outcome: 'already_claimed' });

    const first = await new InngestTestEngine({ function: ciRunnerBoot }).execute({
      events: [bootEvent(intentId, 'evt-sweep')],
    });
    const second = await new InngestTestEngine({ function: ciRunnerBoot }).execute({
      events: [bootEvent(intentId, 'evt-webhook')],
    });

    expect(first.result).toEqual(SETTLED_JSON);
    expect(second.result).toEqual({ outcome: 'already_claimed' });
    // Once per DISPATCH — two dispatches, two calls, and not one more.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('an intent that no longer exists is re-derived rather than memoized, and costs nothing to replay', async () => {
    // `unknown_intent` has no row to write the memo to, so the replay re-derives
    // it — the one case where the supervision legitimately runs per pass. It is
    // also the one case where that is free: `runIntent` returns before the
    // admission gate, so nothing is claimed, counted or spent.
    const run = vi.spyOn(ciRunnerBootService, 'runIntent').mockResolvedValue({
      outcome: 'unknown_intent',
    });

    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({ events: [bootEvent('i-does-not-exist')] });

    expect(result).toEqual({ outcome: 'unknown_intent' });
    const ledger = await db.jobRun.findFirstOrThrow();
    expect(ledger.output).toEqual({ outcome: 'unknown_intent' });
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
