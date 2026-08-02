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
// ⚠️ TWO COMPARISONS, ONE JOB (§Q, MOTIR-1924). Since project CI moved to
// Motir's own fleet, a metered minute is no longer necessarily a GitHub-BILLED
// minute, and GitHub's report says nothing about the fleet. So the month is
// audited against two sources: the GitHub-hosted subset against the billing
// report, and the fleet subset against the orchestrator's container-seconds
// record. Both run every month, independently — the fleet half needs no billing
// credential, so it reports from the first fleet job onward even while the
// GitHub half is still `skipped` waiting for MOTIR-1779's token.
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
    // The job's clock read is confined to this one line so the pure period maths
    // above stays testable without faking time.
    const periodStart = previousPeriodStart(new Date());

    const github = await ctx.step.run('reconcile-github-billed', async () => {
      const metered =
        await services.ciMinutesReconciliation.githubHostedTotalsForMonth(periodStart);
      // `getUTCMonth()` is 0-based; GitHub's usage endpoint takes 1-based months.
      return services.ciMinutesReconciliation.reconcileMonth(
        periodStart.getUTCFullYear(),
        periodStart.getUTCMonth() + 1,
        metered,
      );
    });

    // A SEPARATE step, deliberately: the fleet audit must run even when the
    // GitHub half skipped for a missing credential, and separate steps are also
    // what puts both outcomes in the `job_run` ledger as distinct, readable
    // records rather than one blended result.
    const fleet = await ctx.step.run('reconcile-fleet', async () =>
      services.ciMinutesReconciliation.reconcileFleetMonth(periodStart),
    );

    return { github, fleet };
  },
);
