import { holdScheduledJob } from './scheduled-job-hold';
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
// The hold itself is `holdScheduledJob` (`scheduled-job-hold.ts`): it pre-writes
// the tick's most recent and next fire as already succeeded, so the scheduler's
// dedupe enqueues neither, then waits for any poll already in flight to settle
// (the failing run's tick fired at 12:20:00 and the degraded write landed seconds
// later).

const TICK = monitorIssueReconcileTick.id;
const POLL = monitorConnectionPoll.id;

/**
 * Keep the scheduled monitor poll from writing the installation's health until at
 * least the fire after next, and return once no poll is in flight.
 */
export async function holdScheduledMonitorPoll(): Promise<void> {
  await holdScheduledJob(TICK, MONITOR_ISSUE_RECONCILE_CRON, [POLL]);
}
