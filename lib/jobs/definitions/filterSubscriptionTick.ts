import { defineJob } from '../defineJob';

// Filter-subscription delivery TICK (Story 6.2 · Subtask 6.2.5) — the hourly
// cron on the 1.6 scheduled primitive (the dailyHealthCheck/attachmentGc
// precedent). Each tick scans every workspace's subscriptions configured for
// the current UTC hour, keeps the ones DUE now (schedule + weekday), and fans
// each out as one `filter-subscription/deliver` event — so a single
// subscription's failure retries/dead-letters on its own, never failing the
// whole tick (the watcher fan-out shape).
//
// `retryPolicy: 'idempotent'`: the scan is read-only + the per-occurrence email
// idempotency key makes a re-enqueue within the same hour collapse to one
// delivery, so the full 5-attempt budget is safe on a transient DB blip
// (unlike the health check's point-in-time 'none').
//
// System-scoped (cross-workspace): the scan runs under withSystemContext inside
// the service (the subscription RLS policy's system-admin branch); the ledger
// row is untenanted, like every `system.*` job. The handler stays tiny — narrow
// to a single durable step that returns the { scanned, due, enqueued } summary
// for the run ledger.

/** Top of every hour — clear of the 09:00 health check + 03:30 attachment GC. */
export const FILTER_SUBSCRIPTION_TICK_CRON = '0 * * * *';

export const filterSubscriptionTick = defineJob(
  {
    id: 'system.filter-subscription-tick',
    cron: FILTER_SUBSCRIPTION_TICK_CRON,
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    // `new Date()` is the tick instant (top of the hour); the service derives
    // the UTC hour + due-ness from it. Tests drive the service directly with a
    // frozen clock.
    return ctx.step.run('enqueue-due-deliveries', () =>
      services.savedFilterSubscriptions.enqueueDueDeliveries(new Date()),
    );
  },
);
