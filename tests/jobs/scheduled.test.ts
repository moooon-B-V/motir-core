import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import {
  dailyHealthCheck,
  DAILY_HEALTH_CHECK_PAYLOAD,
  DAILY_HEALTH_CHECK_CRON,
} from '@/lib/jobs/definitions/dailyHealthCheck';
import { truncateJobRuns } from '../helpers/db';
import { seedHealthyJobSchedules } from '../helpers/jobs';

// Scheduled-job primitive (Story 1.6 · Subtask 1.6.4) — the replacement for the
// 1.6.2 system.ping smoke test. Drives the `system.daily-health-check` cron job
// IN-PROCESS via @inngest/test (no live scheduler / dev server / cloud) and
// asserts the contract the scheduled path provides:
//   1. the function resolves to its static payload, and
//   2. the defineJob wrapper persisted a succeeded job_run row whose event_name
//      is the SYNTHETIC `scheduled.system.daily-health-check` (not Inngest's
//      internal cron-timer event name) — so the dashboard treats scheduled +
//      event-triggered runs uniformly, and
//   3. the cron expression is wired into the Inngest function config.

beforeEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

// A cron job has NO event trigger, so we invoke it WITHOUT an `events` array:
// @inngest/test then drives it via the internal `inngest/function.invoked`
// event (the direct-invoke path), which bypasses trigger-event validation. The
// wrapper records the ledger event_name as the synthetic `scheduled.{id}`
// regardless, so the assertions below prove the override.

// As of MOTIR-1970 the health check carries a real probe (the schedule-health
// check), so it only SUCCEEDS when every registered cron job is firing. These
// tests are about the scheduled-path primitive, not the probe, so they make the
// schedules healthy first — the probe's own behaviour is covered in
// `schedule-health.test.ts`.

describe('system.daily-health-check scheduled job', () => {
  it('runs to completion and returns the static payload', async () => {
    await seedHealthyJobSchedules();
    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result } = await engine.execute();

    expect(result).toMatchObject(DAILY_HEALTH_CHECK_PAYLOAD);
  });

  it('writes a succeeded job_run row with the synthetic scheduled event name', async () => {
    await seedHealthyJobSchedules();
    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    await engine.execute();

    // Only the wrapper writes a row for THIS function (the seed skips it), so
    // there is exactly one and it is the one under test.
    const runs = await db.jobRun.findMany({ where: { functionId: 'system.daily-health-check' } });
    expect(runs).toHaveLength(1);

    const run = runs[0]!;
    expect(run.functionId).toBe('system.daily-health-check');
    // The ledger event name is the synthetic scheduled.{id}, NOT event.name.
    expect(run.eventName).toBe('scheduled.system.daily-health-check');
    expect(run.status).toBe('succeeded');
    // System job → untenanted.
    expect(run.workspaceId).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).not.toBeNull();
    expect(run.failure).toBeNull();
  });

  it('wires the cron expression into the Inngest function config', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob(
        { id: 'system.daily-health-check', cron: DAILY_HEALTH_CHECK_CRON },
        () => undefined,
      );
      const config = spy.mock.calls.at(-1)?.[0] as
        | { triggers?: Array<{ cron?: string }> }
        | undefined;
      expect(config?.triggers).toEqual([{ cron: '0 9 * * *' }]);
    } finally {
      spy.mockRestore();
    }
  });
});
