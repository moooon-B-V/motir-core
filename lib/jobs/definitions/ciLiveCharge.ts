import { defineJob } from '../defineJob';

/**
 * CI IS DEBITED WHILE IT RUNS (Story MOTIR-6906 · MOTIR-6910 ·
 * `docs/decisions/fleet-per-org-pool.md` §3).
 *
 * Every debit period, every live CI container's whole minutes since its last tick
 * are added to its org's CI consumption and charged through the shipped
 * allowance-then-credits path (`ciLiveChargeService`). This is what keeps an
 * org's balance current while its CI runs, so the coverage admission and the stop
 * at zero (MOTIR-6911) read a number that is at most one period behind.
 *
 * ⚠️ ONE JOB OVER EVERY ORG, NEVER GATED ON ACTIVITY. An org at zero matters most
 * when nobody is watching it; a tick over an org with nothing running does
 * nothing.
 *
 * ⚠️ THE CADENCE IS THE DEBIT PERIOD. §3 derives five minutes from the worst-case
 * overshoot; it lands on MOTIR-6893's default sub-hourly cadence, so it needs no
 * exception entry. `LIVE_CHARGE_PERIOD_MS` in the service is the same number, and
 * is the idempotency key's clock.
 */
export const CI_LIVE_CHARGE_CRON = '*/5 * * * *';

export const ciLiveCharge = defineJob(
  {
    id: 'system.ci-live-charge',
    cron: CI_LIVE_CHARGE_CRON,
    // `latest`: a missed tick is not work to replay. The checkpoint is a sum, so
    // the next tick adds every whole minute the missed ones would have.
    catchUp: 'latest',
    // A retried tick finds each container's (intent, period) row already written
    // and adds nothing; the debit's own ref makes its replay a no-op at motir-ai.
    retryPolicy: 'idempotent',
  },
  (ctx, services) => {
    return ctx.step.run('ci-live-charge', () => services.ciLiveCharge.tick(new Date()));
  },
);
