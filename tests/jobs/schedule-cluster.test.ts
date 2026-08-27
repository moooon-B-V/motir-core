import { describe, expect, it } from 'vitest';

import { parseCron } from '@/lib/jobs/cron';
import {
  jobSchedules,
  longestQuietGapMinutes,
  MIN_QUIET_GAP_MINUTES,
  SCHEDULE_CLUSTER_MINUTES,
  shortestWakeGapMinutes,
  wakeMinutes,
} from '@/lib/jobs/schedules';

// The schedule table only holds jobs whose definition module has been evaluated,
// so the registry import is load-bearing rather than decorative — without it this
// suite would assert an invariant over an EMPTY table and pass for the wrong
// reason. `lib/jobs/schedules.ts` says so in its own header.
import '@/lib/jobs/registry';

// THE CLUSTER INVARIANT (MOTIR-3314).
//
// Motir's Postgres suspends when idle and bills by how often it WAKES, and every
// tick of every scheduled job is a guaranteed database WRITE (`defineJob` records
// a `job_run` row before the handler body runs). So the bill is a property of the
// SET of schedules, which means no single job's comment can defend it: the next
// person adding a scheduled job picks a free-looking minute — for the
// load-spreading reasons that are correct on an always-on machine — and quietly
// re-opens the gap. Nothing fails, nothing alerts, and the bill returns months
// later with no diff to blame.
//
// That is the failure mode this file exists to remove. It asserts the INVARIANT
// (the gap clears the floor) rather than the VALUES (which minutes today's
// fourteen jobs sit on), so a fifteenth job is free to pick either slot and is
// stopped only if it re-opens the gap.
//
// The measurement the floor is priced against is
// `docs/decisions/application-hosting.md` §21.

describe('the `system.*` schedule is CLUSTERED — the quiet gap the compute sleeps in', () => {
  it('every registered expression PARSES with the repo cron evaluator', () => {
    // `wakeMinutes` would throw on an unsupported expression anyway, but a
    // failure there reads as "the gap is wrong" rather than "job X's cron is
    // exotic". Named separately so the diagnosis arrives with the failure.
    const schedules = jobSchedules();
    expect(schedules.length).toBeGreaterThan(0);
    for (const { functionId, cron } of schedules) {
      expect(() => parseCron(cron), `${functionId} parses ("${cron}")`).not.toThrow();
    }
  });

  it('EVERY gap clears the floor — the invariant', () => {
    // Asserted on the SHORTEST gap, not the longest. A schedule is only as
    // clustered as its tightest pair, and the test below is the demonstration
    // that a longest-gap assertion would not defend the bill.
    expect(shortestWakeGapMinutes()).toBeGreaterThanOrEqual(MIN_QUIET_GAP_MINUTES);
    // On a fully clustered schedule the two readings coincide, which is what
    // "clustered" means: the wake-minutes are evenly spread over the hour.
    expect(longestQuietGapMinutes()).toBe(shortestWakeGapMinutes());
  });

  it('no job fires on a minute outside the cluster', () => {
    // Strictly stronger than the gap assertion and kept BESIDE it rather than
    // instead of it, because it fails with the offending job's NAME. The gap
    // check is the contract; this one is the error message.
    for (const { functionId, cron } of jobSchedules()) {
      for (const minute of parseCron(cron).minute) {
        expect(
          SCHEDULE_CLUSTER_MINUTES,
          `${functionId} ("${cron}") fires at :${String(minute).padStart(2, '0')}, ` +
            `which is not one of the clustered minutes — see lib/jobs/schedules.ts`,
        ).toContain(minute);
      }
    }
  });

  it('a job added on a free-looking minute is CAUGHT — and would not be by the longest gap', () => {
    // The guard has to be shown to BITE: a check asserted only against today's
    // table proves the table is fine today and says nothing about whether it
    // could ever fail. This is the fifteenth job — someone picking :17 because it
    // looks free, which is the exact reasoning that produced the old shape.
    const withStray = [...jobSchedules(), { functionId: 'system.stray', cron: '17 * * * *' }];
    expect(wakeMinutes(withStray)).toEqual([0, 17, 30]);

    // ⚠️ THE POINT OF THIS TEST. :17 splits ONE of the two half-hours and leaves
    // the OTHER untouched, so the LONGEST gap is still 30 and unchanged — a
    // longest-gap assertion passes while the compute stops sleeping for half the
    // hour. This is why the invariant above is the shortest gap.
    expect(longestQuietGapMinutes(withStray)).toBe(longestQuietGapMinutes());
    expect(longestQuietGapMinutes(withStray)).toBeGreaterThanOrEqual(MIN_QUIET_GAP_MINUTES);

    expect(shortestWakeGapMinutes(withStray)).toBe(13);
    expect(shortestWakeGapMinutes(withStray)).toBeLessThan(MIN_QUIET_GAP_MINUTES);
  });

  it('a DAILY job counts as opening its minute, however rarely it fires', () => {
    // The conservative reading, asserted so it cannot be relaxed by accident: a
    // nightly sweep at 04:45 wakes the compute at :45 on the night it runs, and
    // a gap that holds on the other 364 days is not a gap. `wakeMinutes` reads
    // the MINUTE field alone for this reason.
    const nightly = [{ functionId: 'system.nightly', cron: '45 4 * * *' }];
    expect(wakeMinutes(nightly)).toEqual([45]);
    expect(longestQuietGapMinutes(nightly)).toBe(60);
    expect(shortestWakeGapMinutes(nightly)).toBe(60);
  });

  it('the gap is CYCLIC, and an empty table has no wake at all', () => {
    // The wrap is the stretch a compute actually sleeps in: from the last
    // wake-minute of one hour to the first of the next. Computed the naive
    // non-cyclic way, {0, 30} would report 30 either way and {5} would report 0
    // — the second is the one that would be wrong.
    expect(longestQuietGapMinutes([{ functionId: 'a', cron: '5 * * * *' }])).toBe(60);
    expect(shortestWakeGapMinutes([{ functionId: 'a', cron: '5 * * * *' }])).toBe(60);
    expect(longestQuietGapMinutes([])).toBe(60);
    expect(shortestWakeGapMinutes([])).toBe(60);
    expect(wakeMinutes([])).toEqual([]);

    // An UNEVEN pair: :00 and :50 leave gaps of 50 and 10. The longest reads a
    // comfortable 50 and the shortest correctly reports the 10 the compute
    // actually has to live with.
    const uneven = [
      { functionId: 'a', cron: '0 * * * *' },
      { functionId: 'b', cron: '50 * * * *' },
    ];
    expect(longestQuietGapMinutes(uneven)).toBe(50);
    expect(shortestWakeGapMinutes(uneven)).toBe(10);
  });

  it('is the shape the PR body and §21 quote — two clustered minutes, a 30-minute gap', () => {
    // Pins the reading the record states, so a change to the shape has to change
    // the record too rather than silently leaving §21 describing a schedule that
    // no longer exists. Not a second copy of the invariant: the invariant is a
    // floor any clustered shape could satisfy, and this is THIS shape.
    expect(jobSchedules().length).toBe(15);
    expect(wakeMinutes()).toEqual([...SCHEDULE_CLUSTER_MINUTES].sort((a, b) => a - b));
    expect(wakeMinutes()).toEqual([0, 30]);
    expect(longestQuietGapMinutes()).toBe(30);
    expect(shortestWakeGapMinutes()).toBe(30);
  });
});
