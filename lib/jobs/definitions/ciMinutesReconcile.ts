import { defineJob } from '../defineJob';
import { periodStartFor } from '@/lib/ciMetering/period';

// Monthly CI-minutes RECONCILIATION (Story MOTIR-1775 · MOTIR-1896) — the audit
// half of `docs/decisions/ci-minutes-allowance.md` §5.8.
//
// The operational meter accumulates from `workflow_run` webhooks; this compares
// the month's accumulated totals against GitHub's OWN billing report, per
// repository, and LOGS any drift past the stated tolerance. Neither figure
// overwrites the other (§5.8: "drift is logged, not silently trusted in either
// direction") — a report that quietly corrected the meter would re-price
// already-charged history, which §3.3 forbids.
//
// WHY it matters rather than being nice-to-have: the ADR's 40% overage margin
// rests on the meter matching what GitHub actually bills. Without this the claim
// is unfalsifiable; with it, a systematic under-count — a run of dropped
// deliveries, an unpriced runner, an attempt counted once — becomes visible the
// month it appears.
//
// Runs on the 3rd, not the 1st: GitHub's usage report for a month is not
// complete the instant the month ends, so reconciling immediately would report
// drift that is only reporting lag. It reconciles the PREVIOUS calendar month.
//
// System-scoped: the comparison spans every tenant, because Motir's GitHub bill
// does (GitHub bills the repository OWNER, and that owner is Motir's org) — no
// single tenant sees the whole bill. The ledger row is untenanted, like every
// `system.*` job.
//
// `retryPolicy: 'idempotent'`: the job only READS and logs — it writes no meter
// rows and mutates nothing — so a transient API/DB blip is worth the full retry
// budget, and a re-run recomputes the same comparison.

/** 04:00 on the 3rd of each month — after GitHub's report settles, and clear of
 *  the 03:30 attachment GC. */
export const CI_MINUTES_RECONCILE_CRON = '0 4 3 * *';

/** The calendar month to reconcile, given "now": the PREVIOUS one. Exported for
 *  the test, which must not depend on the wall clock. */
export function previousPeriodStart(now: Date): Date {
  const thisPeriod = periodStartFor(now);
  return new Date(Date.UTC(thisPeriod.getUTCFullYear(), thisPeriod.getUTCMonth() - 1, 1));
}

export const ciMinutesReconcile = defineJob(
  { id: 'system.ci-minutes-reconcile', cron: CI_MINUTES_RECONCILE_CRON, retryPolicy: 'idempotent' },
  async (ctx, services) => {
    return ctx.step.run('reconcile-previous-month', async () => {
      // The job's clock read is confined to this one line so the pure period
      // maths above stays testable without faking time.
      const periodStart = previousPeriodStart(new Date());
      const metered = await services.ciMinutesReconciliation.meteredTotalsForMonth(periodStart);
      // `getUTCMonth()` is 0-based; GitHub's usage endpoint takes 1-based months.
      return services.ciMinutesReconciliation.reconcileMonth(
        periodStart.getUTCFullYear(),
        periodStart.getUTCMonth() + 1,
        metered,
      );
    });
  },
);
