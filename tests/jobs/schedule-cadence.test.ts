import { describe, expect, it } from 'vitest';

import { parseCron } from '@/lib/jobs/cron';
import {
  firesMoreThanOncePerHour,
  jobSchedules,
  SUB_HOURLY_CADENCE,
  SUB_HOURLY_CADENCE_EXCEPTIONS,
  subHourlyCadenceViolations,
} from '@/lib/jobs/schedules';

// The schedule table only holds jobs whose definition module has been evaluated,
// so the registry import is load-bearing rather than decorative — without it this
// suite would assert an invariant over an EMPTY table and pass for the wrong
// reason. `lib/jobs/schedules.ts` says so in its own header.
import '@/lib/jobs/registry';

// THE CADENCE INVARIANT (MOTIR-6893 · MOTIR-6932).
//
// Every `system.*` job that fires more than once an hour fires on exactly
// `*/5 * * * *`, unless `SUB_HOURLY_CADENCE_EXCEPTIONS` names it with a reason.
// It replaced the :00/:30 cluster (MOTIR-3314), whose only purpose — letting a
// suspend-when-idle database sleep between ticks — stopped existing once the
// job worker began polling Postgres every few seconds
// (`docs/decisions/always-on-database-job-cadence.md`).
//
// ⚠️ NO JOB COUNT IS ASSERTED, deliberately. The cluster test pinned
// `jobSchedules().length`, so every new job broke an unrelated test and every
// pair of in-flight jobs merged to a number that was wrong for both. The
// invariant is over the SHAPE of each cron, so a new job is checked the moment
// it registers and costs no edit here.

describe('the `system.*` schedule — every sub-hourly job runs every 5 minutes', () => {
  it('every registered expression PARSES with the repo cron evaluator', () => {
    // Named separately so an exotic cron fails as "job X's cron is exotic", not
    // as a confusing cadence violation.
    const schedules = jobSchedules();
    expect(schedules.length).toBeGreaterThan(0);
    for (const { functionId, cron } of schedules) {
      expect(() => parseCron(cron), `${functionId} parses ("${cron}")`).not.toThrow();
    }
  });

  it('every sub-hourly cron is exactly `*/5 * * * *` unless it is a named exception', () => {
    // One assertion per job so a failure arrives with the offending job's NAME.
    for (const { functionId, cron } of jobSchedules()) {
      if (!firesMoreThanOncePerHour(cron)) continue;
      if (Object.hasOwn(SUB_HOURLY_CADENCE_EXCEPTIONS, functionId)) continue;
      expect(
        cron,
        `${functionId} ("${cron}") fires more than once an hour but not on ` +
          `"${SUB_HOURLY_CADENCE}" — use that cadence, or name it in ` +
          `SUB_HOURLY_CADENCE_EXCEPTIONS with a reason (lib/jobs/schedules.ts)`,
      ).toBe(SUB_HOURLY_CADENCE);
    }
    expect(subHourlyCadenceViolations()).toEqual([]);
  });

  it('every exception names a registered job and gives a reason', () => {
    // An entry for a job that no longer exists is an exemption nobody can see
    // the cost of; an entry without a reason is a convention, not a decision.
    const ids = new Set(jobSchedules().map((s) => s.functionId));
    for (const [functionId, reason] of Object.entries(SUB_HOURLY_CADENCE_EXCEPTIONS)) {
      expect(ids.has(functionId), `${functionId} is a registered job`).toBe(true);
      expect(reason.trim(), `${functionId} carries a reason`).not.toBe('');
    }
  });

  it('a seeded `0,30` stray is CAUGHT, by name', () => {
    // The guard has to be shown to BITE: a check asserted only against today's
    // table proves the table is fine today and says nothing about whether it
    // could ever fail. The retired cluster cadence is the likeliest stray.
    const stray = { functionId: 'system.stray-cluster', cron: '0,30 * * * *' };
    expect(subHourlyCadenceViolations([...jobSchedules(), stray])).toContainEqual(stray);
  });

  it('a seeded `*/7` stray is CAUGHT, by name', () => {
    const stray = { functionId: 'system.stray-seven', cron: '*/7 * * * *' };
    expect(subHourlyCadenceViolations([...jobSchedules(), stray])).toContainEqual(stray);
  });

  it('a stray named in the exception map passes — the map is the only way out', () => {
    const stray = { functionId: 'system.stray-seven', cron: '*/7 * * * *' };
    expect(
      subHourlyCadenceViolations([stray], { 'system.stray-seven': 'a derived 7-minute period' }),
    ).toEqual([]);
  });

  it('hourly-and-slower crons are outside the invariant, whatever their minute', () => {
    // Only sub-hourly jobs are held to one cadence; an hourly, daily, weekly or
    // monthly job keeps the minute its own definition argues for.
    const slow = [
      { functionId: 'a', cron: '17 * * * *' },
      { functionId: 'b', cron: '45 4 * * *' },
      { functionId: 'c', cron: '0 9 * * 1' },
      { functionId: 'd', cron: '30 5 3 * *' },
    ];
    for (const { cron } of slow) expect(firesMoreThanOncePerHour(cron)).toBe(false);
    expect(subHourlyCadenceViolations(slow)).toEqual([]);
  });

  it('a cron firing twice in ONE hour of the day is sub-hourly for that hour', () => {
    // The minute field decides: `0,30 9 * * *` fires at 09:00 and 09:30.
    expect(firesMoreThanOncePerHour('0,30 9 * * *')).toBe(true);
    expect(firesMoreThanOncePerHour('* * * * *')).toBe(true);
    expect(firesMoreThanOncePerHour(SUB_HOURLY_CADENCE)).toBe(true);
  });
});
