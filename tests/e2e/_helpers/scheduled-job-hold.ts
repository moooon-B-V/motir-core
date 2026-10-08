import { expect } from '@playwright/test';
import { adminDb } from '@/tests/helpers/adminDb';
import { cronMatches, parseCron, previousFireAtOrBefore } from '@/lib/jobs/cron';

// HOLD ONE SCHEDULED CRON JOB OFF A SPEC (Bugs MOTIR-7840 · MOTIR-7794).
//
// The lane's job worker runs every cron job on its real schedule, beside the
// specs. A spec whose fixture a scheduled job would rewrite — a monitor poll
// writing `connected`, a live CI charge accruing against a seeded running job —
// passes or fails on whether a fire lands inside it.
//
// ⚠️ THE HOLD IS THE SCHEDULER'S OWN DEDUPE, NOT A SLEEP. The scheduler enqueues
// a fire with `job_queue`'s `(job_id, scheduled_for)` unique and treats a row that
// already holds it as `already-queued` (`lib/jobs/engine/scheduler.ts`). So this
// writes that row first, already `succeeded`, for the most recent fire and the
// next one: neither can be enqueued, and nothing starts before the fire after
// next. Then it waits for whatever was ALREADY in flight to settle, because a run
// dispatched just before the hold still finishes.
//
// ⚠️ THE MOST RECENT FIRE MATTERS AS MUCH AS THE NEXT ONE. `resetDatabase`
// truncates `job_queue`, and a `catchUp: 'latest'` job then owes its most recent
// fire again on the scheduler's next pass, seconds later, not five minutes later.
//
// Nothing is released afterwards: the next spec's `resetDatabase` truncates
// `job_queue`, and a held fire in the past is simply one that was not run.

/** The first fire of `cron` strictly after `at`. */
function nextFireAfter(cronExpr: string, at: Date): Date {
  const cron = parseCron(cronExpr);
  const candidate = new Date(at.getTime());
  candidate.setUTCSeconds(0, 0);
  for (let minute = 0; minute < 24 * 60; minute++) {
    candidate.setTime(candidate.getTime() + 60_000);
    if (cronMatches(cron, candidate)) return candidate;
  }
  throw new Error(`${cronExpr} has no fire within a day of ${at.toISOString()}`);
}

/**
 * Keep the scheduled job `jobId` (cron `cronExpr`) from running until at least
 * the fire after next, and return once neither it nor any of `inFlightJobIds`
 * (the jobs it fans out to) is pending or running.
 */
export async function holdScheduledJob(
  jobId: string,
  cronExpr: string,
  inFlightJobIds: readonly string[] = [],
): Promise<void> {
  const now = new Date();
  const fires = [previousFireAtOrBefore(cronExpr, now), nextFireAfter(cronExpr, now)];
  await adminDb.jobQueueRun.createMany({
    data: fires
      .filter((fire): fire is Date => fire !== null)
      .map((fire) => ({
        jobId,
        eventName: `scheduled.${jobId}`,
        scheduledFor: fire,
        runAt: fire,
        maxAttempts: 1,
        state: 'succeeded' as const,
      })),
    skipDuplicates: true,
  });

  // The authoritative signal: nothing of this job's left to run.
  await expect
    .poll(
      () =>
        adminDb.jobQueueRun.count({
          where: {
            jobId: { in: [jobId, ...inFlightJobIds] },
            state: { in: ['pending', 'running'] },
          },
        }),
      { message: `a scheduled ${jobId} run is still in flight` },
    )
    .toBe(0);
}
