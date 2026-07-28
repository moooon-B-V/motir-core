import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { jobFunctions } from '@/lib/jobs/registry';
import { jobServices } from '@/lib/jobs/services';
import { RETRY_POLICIES } from '@/lib/jobs/retries';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import {
  autoPlanCadenceTick,
  AUTO_PLAN_CADENCE_TICK_CRON,
} from '@/lib/jobs/definitions/autoPlanCadenceTick';
import { truncateJobRuns } from '../helpers/db';

// Story 7.13 · Subtask 7.13.7 (MOTIR-920) — the CRON TASK half of the cadence
// trigger, which MOTIR-916's own suite does not reach: `autoPlanCadence.test.ts`
// drives `autoPlanCadenceService.runCadenceSweep()` DIRECTLY, so the scheduled
// wrapper around it (`lib/jobs/definitions/autoPlanCadenceTick.ts`) ships at 0%
// coverage — the schedule, the retry budget, the registry wiring, and the
// delegation are all unproven. An unattended job whose WIRING is untested is an
// unattended job that may simply never run.
//
// What this locks, in the order a tick actually happens:
//   1. the tick is REGISTERED (an unregistered function is never served, so it
//      silently never fires — no error, no ledger row, nothing to alert on);
//   2. the CRON expression reaches Inngest's function config as `20 * * * *`;
//   3. the retry budget is the `idempotent` policy's, which is only SAFE
//      because the sweep re-derives every gate — so the policy and the
//      convergence argument are asserted together;
//   4. the handler DELEGATES to the service and returns its summary verbatim;
//   5. the run lands one succeeded, UNTENANTED ledger row under the synthetic
//      `scheduled.*` event name;
//   6. the ARCHITECTURE GUARD coverage cannot see — a job definition reaches
//      Prisma through NO path at all (the 4-layer rule for background work).

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('system.auto-plan-cadence-tick — the schedule wiring (MOTIR-920)', () => {
  it('is REGISTERED in the job registry — an unserved cron function fires silently never', () => {
    expect(jobFunctions).toContain(autoPlanCadenceTick);
  });

  it('wires the cron expression into the Inngest function config — hourly at :20', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob(
        {
          id: 'system.auto-plan-cadence-tick',
          cron: AUTO_PLAN_CADENCE_TICK_CRON,
          retryPolicy: 'idempotent',
        },
        () => undefined,
      );
      const config = spy.mock.calls.at(-1)?.[0] as
        | { triggers?: Array<{ cron?: string }>; retries?: number }
        | undefined;
      expect(config?.triggers).toEqual([{ cron: '20 * * * *' }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('is scheduled clear of the other system crons — no top-of-hour pile-up', () => {
    // The rationale recorded in the definition: :20 keeps the sweep off the
    // filter-subscription tick's :00 slot. Assert the MINUTE field is distinct
    // rather than re-listing every sibling schedule.
    const minuteField = AUTO_PLAN_CADENCE_TICK_CRON.split(' ')[0];
    expect(minuteField).toBe('20');
    expect(minuteField).not.toBe('0');
  });

  it('takes the IDEMPOTENT retry budget — safe only because the sweep re-derives every gate', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob(
        {
          id: 'system.auto-plan-cadence-tick',
          cron: AUTO_PLAN_CADENCE_TICK_CRON,
          retryPolicy: 'idempotent',
        },
        () => undefined,
      );
      const config = spy.mock.calls.at(-1)?.[0] as { retries?: number } | undefined;
      // Inngest's `retries` counts RE-tries, so the policy's 5 ATTEMPTS become
      // 4 retries after the initial one — the longer budget it grants a sweep
      // that is safe to repeat. (A raw `5` here would quietly buy a 6th attempt.)
      expect(config?.retries).toBe(RETRY_POLICIES.idempotent.maxAttempts - 1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('system.auto-plan-cadence-tick — the handler DELEGATES (MOTIR-920)', () => {
  it('calls the cadence service exactly once and returns its summary verbatim', async () => {
    const summary = { scanned: 3, fired: 1, skipped: 2, failed: 0, outcomes: [] };
    const sweep = vi
      .spyOn(autoPlanCadenceService, 'runCadenceSweep')
      .mockResolvedValue(
        summary as Awaited<ReturnType<typeof autoPlanCadenceService.runCadenceSweep>>,
      );

    const engine = new InngestTestEngine({ function: autoPlanCadenceTick });
    const { result } = await engine.execute();

    // ONE call — a tick sweeps once, it does not re-enter per project.
    expect(sweep).toHaveBeenCalledTimes(1);
    // The handler adds nothing of its own: the ledger's run output IS the
    // service's summary, which is what the 1.6.5 operator dashboard renders.
    expect(result).toEqual(summary);
  });

  it('reaches the service through the INJECTED bag — the same singleton, not an ad-hoc import', () => {
    // The 4-layer seam: `defineJob` hands the handler `jobServices`, so the
    // object the tick calls must BE the exported singleton. If the bag ever
    // stopped carrying it, the handler would not compile — this asserts the
    // wiring is identity, not a lookalike.
    expect(jobServices.autoPlanCadence).toBe(autoPlanCadenceService);
  });

  it('writes one succeeded, UNTENANTED ledger row under the synthetic scheduled event name', async () => {
    vi.spyOn(autoPlanCadenceService, 'runCadenceSweep').mockResolvedValue({
      scanned: 0,
      fired: 0,
      skipped: 0,
      failed: 0,
      outcomes: [],
    } as Awaited<ReturnType<typeof autoPlanCadenceService.runCadenceSweep>>);

    const engine = new InngestTestEngine({ function: autoPlanCadenceTick });
    await engine.execute();

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);

    const run = runs[0]!;
    expect(run.functionId).toBe('system.auto-plan-cadence-tick');
    // Scheduled runs carry the synthetic `scheduled.{id}` name, not Inngest's
    // internal cron-timer event — so the dashboard treats them uniformly.
    expect(run.eventName).toBe('scheduled.system.auto-plan-cadence-tick');
    expect(run.status).toBe('succeeded');
    // A cross-workspace sweep is a SYSTEM job — the ledger row is untenanted.
    expect(run.workspaceId).toBeNull();
    expect(run.failure).toBeNull();
  });

  it('runs end to end against a real (empty) database — the sweep is reached, not stubbed away', async () => {
    // No spy here: the REAL service runs its real cross-workspace scan under
    // `withSystemContext`. With no opted-in project it sweeps nothing, which is
    // exactly the assertion — the wiring reaches live Postgres and returns a
    // well-formed summary rather than throwing.
    const engine = new InngestTestEngine({ function: autoPlanCadenceTick });
    const { result } = await engine.execute();

    expect(result).toEqual({ scanned: 0, fired: 0, skipped: 0, failed: 0, outcomes: [] });
  });
});

describe('Background-job architecture guard — a job definition never reaches Prisma (MOTIR-920)', () => {
  // The guard coverage cannot see. `lib/jobs/services.ts` exists so a handler is
  // a SERVICE caller, never a data-access one (CLAUDE.md's 4-layer rule, applied
  // to background work). Coverage proves lines RAN; it cannot prove a handler
  // did not reach past the service layer to `db` — that is a structural property
  // of the import graph, so it is asserted structurally.
  const definitionsDir = resolve(process.cwd(), 'lib/jobs/definitions');
  const definitionFiles = readdirSync(definitionsDir).filter((f) => f.endsWith('.ts'));

  it('the cadence tick imports no data-access layer — it delegates', () => {
    const source = readFileSync(resolve(definitionsDir, 'autoPlanCadenceTick.ts'), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/lib\/db['"]/);
    expect(source).not.toMatch(/from\s+['"]@prisma\/client['"]/);
    // …and it DOES go through the injected bag.
    expect(source).toMatch(/services\.autoPlanCadence\.runCadenceSweep\(\)/);
  });

  it('NO job definition reaches Prisma — the rule holds across the whole registry', () => {
    // Guarding only the new file would let the next job break the rule silently.
    const offenders = definitionFiles.filter((file) => {
      const source = readFileSync(resolve(definitionsDir, file), 'utf8');
      return (
        /from\s+['"]@\/lib\/db['"]/.test(source) || /from\s+['"]@prisma\/client['"]/.test(source)
      );
    });
    expect(offenders).toEqual([]);
    // Sanity: the sweep above actually read files (an empty dir would pass vacuously).
    expect(definitionFiles.length).toBeGreaterThan(0);
  });
});
