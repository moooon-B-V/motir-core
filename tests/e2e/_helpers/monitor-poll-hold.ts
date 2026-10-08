import { expect } from '@playwright/test';
import { adminDb } from '@/tests/helpers/adminDb';
import { cronMatches, parseCron, previousFireAtOrBefore } from '@/lib/jobs/cron';
import {
  MONITOR_ISSUE_RECONCILE_CRON,
  monitorConnectionPoll,
  monitorIssueReconcileTick,
} from '@/lib/jobs/definitions/monitorIssueReconcile';

// HOLD THE SCHEDULED MONITOR POLL OFF A SPEC'S FIXTURE WRITE (Bug MOTIR-7840).
//
// The lane's job worker runs `system.monitor-issue-reconcile` every five minutes,
// and every successful poll ends by writing `health: 'connected'` onto the
// installation (`monitorIngestionService.pollConnection`). The fake provider
// always answers, so a spec that writes `degraded` straight into
// `monitor_installation` and then asserts it lost to any poll landing between the
// write and the assertion: the room rendered "Connected · checked now" and the
// assertion timed out on a DOM that had already settled on the wrong value. It
// failed only when the chapter straddled a five-minute boundary, which is why it
// passed most runs.
//
// ⚠️ THE HOLD IS THE SCHEDULER'S OWN DEDUPE, NOT A SLEEP. The scheduler enqueues
// a fire with `job_queue`'s `(job_id, scheduled_for)` unique and treats a row that
// already holds it as `already-queued` (`lib/jobs/engine/scheduler.ts`). So this
// writes that row first, already `succeeded`, for the most recent fire and the
// next one: neither can be enqueued, and no poll can start before the fire after
// next — at least five minutes away, far longer than one chapter. Then it waits
// for whatever was ALREADY in flight to settle, because a poll dispatched just
// before the hold still ends with its `connected` write (the failing run's tick
// fired at 12:20:00 and the degraded write landed seconds later).
//
// Nothing is released afterwards: the next spec's `resetDatabase` truncates
// `job_queue`, and a held fire in the past is simply one that was not run.

const TICK = monitorIssueReconcileTick.id;
const POLL = monitorConnectionPoll.id;

/** The first fire of the reconcile cron strictly after `at`. */
function nextFireAfter(at: Date): Date {
  const cron = parseCron(MONITOR_ISSUE_RECONCILE_CRON);
  const candidate = new Date(at.getTime());
  candidate.setUTCSeconds(0, 0);
  for (let minute = 0; minute < 24 * 60; minute++) {
    candidate.setTime(candidate.getTime() + 60_000);
    if (cronMatches(cron, candidate)) return candidate;
  }
  throw new Error(
    `${MONITOR_ISSUE_RECONCILE_CRON} has no fire within a day of ${at.toISOString()}`,
  );
}

/**
 * Keep the scheduled monitor poll from writing the installation's health until at
 * least the fire after next, and return once no poll is in flight.
 */
export async function holdScheduledMonitorPoll(): Promise<void> {
  const now = new Date();
  const fires = [previousFireAtOrBefore(MONITOR_ISSUE_RECONCILE_CRON, now), nextFireAfter(now)];
  await adminDb.jobQueueRun.createMany({
    data: fires
      .filter((fire): fire is Date => fire !== null)
      .map((fire) => ({
        jobId: TICK,
        eventName: `scheduled.${TICK}`,
        scheduledFor: fire,
        runAt: fire,
        maxAttempts: 1,
        state: 'succeeded' as const,
      })),
    skipDuplicates: true,
  });

  // The authoritative signal: no tick and no per-connection poll left to run.
  await expect
    .poll(
      () =>
        adminDb.jobQueueRun.count({
          where: { jobId: { in: [TICK, POLL] }, state: { in: ['pending', 'running'] } },
        }),
      { message: 'a scheduled monitor poll is still in flight' },
    )
    .toBe(0);
}
