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
import {
  CI_RUNNER_PROVISION_SWEEP_CRON,
  CI_RUNNER_REAP_CRON,
  ciRunnerBoot,
  ciRunnerProvisionSweep,
  ciRunnerReap,
} from '@/lib/jobs/definitions/ciRunnerFleet';
import { truncateJobRuns } from '../helpers/db';

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

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
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
    expect(send.mock.calls[0]![0]).toEqual({
      name: 'system.ci-runner-boot',
      data: { intentId: 'i1', workspaceId: '' },
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
  it("the boot handler passes the event's intent id to the service and returns its outcome", async () => {
    const outcome = { outcome: 'unknown_intent' } as const;
    const run = vi.spyOn(ciRunnerBootService, 'runIntent').mockResolvedValue(outcome);
    const engine = new InngestTestEngine({ function: ciRunnerBoot });
    const { result } = await engine.execute({
      events: [{ name: 'system.ci-runner-boot', data: { intentId: 'i-42', workspaceId: '' } }],
    });

    expect(run).toHaveBeenCalledExactlyOnceWith('i-42');
    expect(result).toEqual(outcome);
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
