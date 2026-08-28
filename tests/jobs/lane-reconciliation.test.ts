import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import {
  DELIBERATELY_ON_INNGEST,
  MIGRATED_TO_ENGINE,
  declaredEngineJobIds,
  declaredInngestJobIds,
  describeLaneDrift,
  describeLaneReconciliation,
  logLaneReconciliation,
  reconcileLanes,
  type LaneDrifted,
} from '@/lib/jobs/engine/census';
import { JOB_ENGINE_JOBS_ENV, JOB_ENGINE_JOBS_FILE_ENV } from '@/lib/jobs/engine/cutover';
import {
  dailyHealthCheck,
  JobLaneDriftError,
  DAILY_HEALTH_CHECK_PAYLOAD,
} from '@/lib/jobs/definitions/dailyHealthCheck';
import { truncateJobRuns } from '../helpers/db';
import { seedHealthyJobSchedules } from '../helpers/jobs';

// THE LANE RECONCILIATION (Bug MOTIR-3716).
//
// `every-job-declares-its-lane.test.ts` asserts the DECLARATION is complete.
// This asserts the declaration and the DEPLOYMENT agree — the half nothing in
// the system had ever compared, and the half that produced four operator cards
// in ~34 hours (MOTIR-3682, MOTIR-3688, MOTIR-3709).
//
// ⚠️ EVERY FIXTURE IS DERIVED FROM `MIGRATED_TO_ENGINE`, never hand-listed. The
// census grows every time a job is added, and a fixture holding its own copy of
// the routed set would be a third list to keep equal — which is the exact defect
// under test, reproduced in the test that measures it.

/** The declaration as the secret would carry it: comma-separated, in order. */
function secretFor(ids: readonly string[]): string {
  return ids.join(',');
}

/** The full declared set — the value a correctly-deployed secret holds. */
const IN_SYNC_SECRET = secretFor(MIGRATED_TO_ENGINE);

/** An id no job has ever had, for the routed-but-not-declared direction. */
const PHANTOM_ID = 'system.this-job-does-not-exist';

const savedEnv = {
  ids: process.env[JOB_ENGINE_JOBS_ENV],
  file: process.env[JOB_ENGINE_JOBS_FILE_ENV],
};

beforeEach(() => {
  // The suite runs with neither set; make that explicit rather than inherited,
  // so one test's leak cannot become another's premise.
  delete process.env[JOB_ENGINE_JOBS_ENV];
  delete process.env[JOB_ENGINE_JOBS_FILE_ENV];
});

afterEach(() => {
  if (savedEnv.ids === undefined) delete process.env[JOB_ENGINE_JOBS_ENV];
  else process.env[JOB_ENGINE_JOBS_ENV] = savedEnv.ids;
  if (savedEnv.file === undefined) delete process.env[JOB_ENGINE_JOBS_FILE_ENV];
  else process.env[JOB_ENGINE_JOBS_FILE_ENV] = savedEnv.file;
});

describe('the declaration is readable from shipped code', () => {
  it('exposes both lists, and the census test asserts against THESE', () => {
    // The point of the move: a list a test file owned could never be compared
    // against the live secret, because no running process could read it.
    expect(MIGRATED_TO_ENGINE.length).toBeGreaterThan(30);
    expect(declaredEngineJobIds().size).toBe(MIGRATED_TO_ENGINE.length);
    // ⚠️ NOT `toBeGreaterThan(0)`. MOTIR-3489 moved the last three entries —
    // the container supervisors — onto the engine, so the exclusion list is
    // EMPTY, and an assertion that it is populated would fail on the very
    // condition MOTIR-3418 is waiting for. What still has to hold either way is
    // that the accessor and the constant agree, so that is what is asserted.
    expect(declaredInngestJobIds().size).toBe(DELIBERATELY_ON_INNGEST.length);
  });

  it('names no job in both lists', () => {
    // Cheap here, and it keeps the invariant true for `reconcileLanes` even if
    // the census test is ever run separately.
    const engine = declaredEngineJobIds();
    const both = [...declaredInngestJobIds()].filter((id) => engine.has(id));
    expect(both).toEqual([]);
  });
});

describe('reconcileLanes — the two-way difference', () => {
  it('reports IN SYNC when the secret carries exactly the declared set', () => {
    // ⚠️ THE EMPTY CASE IS ASSERTED, not inferred from the absence of noise: a
    // clean deployment answers with a POSITIVE verdict carrying the count it
    // agreed on, so a green ledger row is a measurement rather than a silence.
    process.env[JOB_ENGINE_JOBS_ENV] = IN_SYNC_SECRET;

    const result = reconcileLanes();

    expect(result).toEqual({ verdict: 'in_sync', routed: MIGRATED_TO_ENGINE.length });
    expect(describeLaneReconciliation(result)).toContain(
      `agree on all ${MIGRATED_TO_ENGINE.length} routed job(s)`,
    );
  });

  it('reports DECLARED-BUT-NOT-ROUTED — the silent direction, and all four measured instances', () => {
    // The job runs on Inngest while a reviewed file says it runs on the engine.
    // Nothing goes red: the scheduler skips it (no timer) and `defineJob`'s
    // Inngest guard does NOT skip it, so it runs daily on the wrong lane.
    const missing = MIGRATED_TO_ENGINE[0]!;
    process.env[JOB_ENGINE_JOBS_ENV] = secretFor(MIGRATED_TO_ENGINE.filter((id) => id !== missing));

    const result = reconcileLanes();

    expect(result.verdict).toBe('drifted');
    const drift = result as LaneDrifted;
    expect(drift.declaredNotRouted).toEqual([missing]);
    expect(drift.routedNotDeclared).toEqual([]);
  });

  it('reports ROUTED-BUT-NOT-DECLARED — production ahead of review', () => {
    // The other direction, and the reason a one-way check is not enough: a
    // check that only looked for declared-but-not-routed would reproduce this
    // very defect, mirrored.
    process.env[JOB_ENGINE_JOBS_ENV] = secretFor([...MIGRATED_TO_ENGINE, PHANTOM_ID]);

    const result = reconcileLanes();

    expect(result.verdict).toBe('drifted');
    const drift = result as LaneDrifted;
    expect(drift.declaredNotRouted).toEqual([]);
    expect(drift.routedNotDeclared).toEqual([PHANTOM_ID]);
  });

  it('reports BOTH directions at once, separately', () => {
    const missing = MIGRATED_TO_ENGINE[0]!;
    process.env[JOB_ENGINE_JOBS_ENV] = secretFor([
      ...MIGRATED_TO_ENGINE.filter((id) => id !== missing),
      PHANTOM_ID,
    ]);

    const result = reconcileLanes();

    const drift = result as LaneDrifted;
    expect(drift.declaredNotRouted).toEqual([missing]);
    expect(drift.routedNotDeclared).toEqual([PHANTOM_ID]);
  });

  it('has NOTHING deliberately left on Inngest — the MOTIR-3418 premise, stated positively', () => {
    // ⚠️ THIS REPLACES A TEST THAT SAMPLED `DELIBERATELY_ON_INNGEST[0]`. That
    // test's scenario was "an operator routes a container supervisor BEFORE
    // MOTIR-3489 ships", and MOTIR-3489 has now shipped: the list is empty, so
    // there is no id to sample and — more to the point — no registered job that
    // is routed-but-not-declared can be constructed from real ids at all,
    // because every registered job is declared for the engine. That is the
    // state, not a coverage gap, and the honest assertion is to say so.
    //
    // The routed-but-not-declared DIRECTION keeps its coverage from the two
    // tests above, which drive it with `PHANTOM_ID`.
    //
    // ⚠️ GUARD ON THE ABSENCE, not on a sample. Were an entry re-added here
    // without its id also leaving `MOTIR_POSTGRES_JOB_IDS`, this goes red and
    // names it, which is exactly the moment MOTIR-3418's premise stops holding.
    expect(
      DELIBERATELY_ON_INNGEST.map((e) => e.id),
      'a job is deliberately on Inngest again — MOTIR-3418 cannot delete the SDK while this is non-empty',
    ).toEqual([]);
  });

  it('reports NOT CUT OVER — its own verdict, never `not_applicable`', () => {
    // ⚠️ THE ARM THAT MATTERS MOST TO KEEP SEPARATE. An unset secret is a
    // legitimate steady state for an install that never started the migration,
    // so it is quiet — but it is NAMED, because an unconfigured deployment that
    // reads as "nothing to check" is the shape this whole card is about.
    const result = reconcileLanes();

    expect(result.verdict).toBe('not_cut_over');
    expect(describeLaneReconciliation(result)).toContain(JOB_ENGINE_JOBS_ENV);
    expect(describeLaneReconciliation(result)).toContain(`${MIGRATED_TO_ENGINE.length} job(s)`);
  });

  it('reports NOT APPLICABLE while the test-only file override is armed', () => {
    // `playwright.config.ts` arms this for the whole E2E lane, where the routed
    // set is a fixture a spec moves mid-run. Comparing a fixture to the census
    // would report drift on every boot — a false alarm that teaches an operator
    // the signal is noise.
    process.env[JOB_ENGINE_JOBS_FILE_ENV] = '/tmp/motir-test-job-routing';
    process.env[JOB_ENGINE_JOBS_ENV] = IN_SYNC_SECRET;

    const result = reconcileLanes();

    expect(result.verdict).toBe('not_applicable');
    expect(describeLaneReconciliation(result)).toContain(JOB_ENGINE_JOBS_FILE_ENV);
  });

  it('treats an EMPTY file-override variable as unarmed, exactly as the switch does', () => {
    process.env[JOB_ENGINE_JOBS_FILE_ENV] = '';
    process.env[JOB_ENGINE_JOBS_ENV] = IN_SYNC_SECRET;

    expect(reconcileLanes().verdict).toBe('in_sync');
  });
});

describe('describeLaneDrift — the message IS the operator surface', () => {
  it('names every drifted id and BOTH directions when both are non-empty', () => {
    const message = describeLaneDrift({
      verdict: 'drifted',
      declaredNotRouted: ['system.attachment-gc', 'system.rate-limit-sweep'],
      routedNotDeclared: [PHANTOM_ID],
    });

    expect(message).toContain('system.attachment-gc');
    expect(message).toContain('system.rate-limit-sweep');
    expect(message).toContain(PHANTOM_ID);
    expect(message).toContain('DECLARED for the engine but ABSENT');
    expect(message).toContain('production is ahead of review');
    expect(message).toContain(JOB_ENGINE_JOBS_ENV);
    expect(message).toContain('docs/jobs.md');
  });

  it('states the EMPTY direction explicitly rather than omitting it', () => {
    // "and nothing in the other direction" is what a reader is checking for, so
    // an omitted half would read as an unreported half.
    const oneWay = describeLaneDrift({
      verdict: 'drifted',
      declaredNotRouted: ['system.attachment-gc'],
      routedNotDeclared: [],
    });
    expect(oneWay).toContain('Nothing is routed-but-not-declared.');

    const otherWay = describeLaneDrift({
      verdict: 'drifted',
      declaredNotRouted: [],
      routedNotDeclared: [PHANTOM_ID],
    });
    expect(otherWay).toContain('Nothing is declared-but-not-routed.');
  });
});

describe('the WORKER start-up report warns and CANNOT fail start-up', () => {
  it('WARNS on a non-empty difference and does not throw', () => {
    // ⚠️ THE ORDINARY DEPLOY WINDOW HAS THE CODE AHEAD OF THE SECRET, and that
    // ordering is REQUIRED — `fly secrets set` restarts the machines on the
    // CURRENT release, so routing an id whose job is not in the running image
    // routes it nowhere. A boot gate here would turn a routine release into an
    // outage. Delete the `warn`/`throw` split in `logLaneReconciliation` and
    // this test is what goes red.
    const missing = MIGRATED_TO_ENGINE[0]!;
    process.env[JOB_ENGINE_JOBS_ENV] = secretFor(MIGRATED_TO_ENGINE.filter((id) => id !== missing));
    const log = { info: vi.fn(), warn: vi.fn() };

    const result = logLaneReconciliation(log);

    expect(result.verdict).toBe('drifted');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0]![0])).toContain(missing);
  });

  it('INFOs the clean case, so a healthy boot says so out loud', () => {
    process.env[JOB_ENGINE_JOBS_ENV] = IN_SYNC_SECRET;
    const log = { info: vi.fn(), warn: vi.fn() };

    expect(logLaneReconciliation(log).verdict).toBe('in_sync');
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('INFOs a deployment that never cut over — quiet, but on the record', () => {
    const log = { info: vi.fn(), warn: vi.fn() };

    expect(logLaneReconciliation(log).verdict).toBe('not_cut_over');
    expect(log.warn).not.toHaveBeenCalled();
    expect(String(log.info.mock.calls[0]![0])).toContain('safety default');
  });
});

// ⚠️ WHY NO FIXTURE HERE ROUTES `system.daily-health-check` ITSELF.
//
// `InngestTestEngine` drives the INNGEST copy of the job, and `defineJob`'s
// cutover guard returns `{ skipped: 'routed-to-postgres-engine' }` without
// running the handler for any id the secret names. That is the switch working
// exactly as designed — in production the engine runs this job — but it means a
// fixture whose secret carries `system.daily-health-check` executes no handler
// and asserts nothing.
//
// So every fixture below leaves this one id out of the routed set, which makes
// the deployment drifted BY CONSTRUCTION and puts `system.daily-health-check` in
// `declaredNotRouted`. The consequence is worth stating rather than working
// around: the `in_sync` arm is not reachable through this driver at all, and it
// is asserted where it can be measured honestly — on `reconcileLanes()` above,
// which is the same call the handler makes.
const HEALTH_CHECK_ID = 'system.daily-health-check';

describe('system.daily-health-check surfaces the difference', () => {
  beforeEach(async () => {
    await truncateJobRuns();
    await seedHealthyJobSchedules();
  });

  it('FAILS the run on a drift, naming both directions in the message', async () => {
    // The message is the DLQ row's `failure`, and the DLQ tab is where an
    // operator already looks — which is the whole point of putting the probe on
    // a job that already has a loud, human-visible failure surface.
    //
    // `@inngest/test` CAPTURES a handler throw onto `error` and hands it back
    // SERIALIZED, flattening the subclass name to plain `Error` — so assert on
    // the MESSAGE, which is the part that survives to the row.
    const missing = MIGRATED_TO_ENGINE.find((id) => id !== HEALTH_CHECK_ID)!;
    process.env[JOB_ENGINE_JOBS_ENV] = secretFor([
      ...MIGRATED_TO_ENGINE.filter((id) => id !== missing && id !== HEALTH_CHECK_ID),
      PHANTOM_ID,
    ]);

    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: unknown;
      error?: { message?: string };
    };

    expect(result).toBeUndefined();
    expect(error!.message).toContain(missing);
    expect(error!.message).toContain(PHANTOM_ID);
    expect(error!.message).toContain('DECLARED for the engine but ABSENT');
    expect(error!.message).toContain('production is ahead of review');
  });

  it('RESOLVES on a quiet verdict and carries it on the HEALTHY tick', async () => {
    // Quiet, and on the record: dead-lettering daily over a migration somebody
    // chose not to run would teach an operator that this row is noise. But the
    // verdict rides the SUCCESSFUL result too — a green run that says
    // `not_cut_over` and one that says `in_sync` are very different states, and
    // a field that only appeared on failure could not tell them apart.
    const engine = new InngestTestEngine({ function: dailyHealthCheck });
    const { result, error } = (await engine.execute()) as {
      result?: { ok: boolean; check: string; lanes: { verdict: string; declared?: number } };
      error?: unknown;
    };

    expect(error).toBeUndefined();
    expect(result!.ok).toBe(DAILY_HEALTH_CHECK_PAYLOAD.ok);
    expect(result!.check).toBe(DAILY_HEALTH_CHECK_PAYLOAD.check);
    expect(result!.lanes.verdict).toBe('not_cut_over');
    expect(result!.lanes.declared).toBe(MIGRATED_TO_ENGINE.length);
  });

  it('constructs JobLaneDriftError from the reconciliation it was given', () => {
    // The error class is what carries the diagnosis across the serialization
    // boundary, so it is asserted directly as well as through the run.
    const drift: LaneDrifted = {
      verdict: 'drifted',
      declaredNotRouted: ['system.attachment-gc'],
      routedNotDeclared: [],
    };
    const err = new JobLaneDriftError(drift);

    expect(err.name).toBe('JobLaneDriftError');
    expect(err.reconciliation).toBe(drift);
    expect(err.message).toBe(describeLaneDrift(drift));
  });
});
