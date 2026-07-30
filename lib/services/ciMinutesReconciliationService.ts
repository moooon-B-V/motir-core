import { getGitProvider } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { withSystemContext } from '@/lib/workspaces/context';
import { ciWorkflowRunUsageRepository } from '@/lib/repositories/ciWorkflowRunUsageRepository';
import { periodEndFor } from '@/lib/ciMetering/period';
import {
  billingUsageToken,
  isCiMeteringEnabled,
  provisioningOrgLogin,
  RECONCILIATION_TOLERANCE_FLOOR_MINUTES,
  RECONCILIATION_TOLERANCE_FRACTION,
} from '@/lib/ciMetering/config';

// The MONTHLY RECONCILIATION of the CI-minutes meter (Story MOTIR-1775 ·
// MOTIR-1896), implementing `docs/decisions/ci-minutes-allowance.md` §5.8's
// second half.
//
// The meter itself accumulates from `workflow_run` completion webhooks — the
// only source that is real-time AND attributable per run. GitHub's own
// per-run `/timing` endpoint and its product-specific billing API would both be
// more direct, and BOTH are closing down, which is why the ADR forbids building
// on them. What remains is the enhanced-billing usage endpoint: summarised by
// SKU / repository / day, with no per-run detail. That is enough to AUDIT the
// meter and never enough to BE the meter.
//
// So the two paths have fixed, non-interchangeable roles: **the webhook path is
// the operational meter; the billing report is the audit.** Drift is LOGGED, not
// silently trusted in either direction — neither figure overwrites the other,
// because a report that quietly corrected the meter would re-price already-
// charged history, and a meter that ignored the report would hide a systematic
// under-count.
//
// This exists because the ADR's stated 40% overage margin DEPENDS on the meter
// tracking what GitHub actually bills. Without a reconciliation that claim is
// unfalsifiable; with one, a divergence is visible the month it appears.

const PROVIDER: GitProviderId = 'github';

/** One repository's meter-vs-report comparison for a period. */
export interface RepoReconciliation {
  repoName: string;
  /** Σ billable minutes the meter recorded — the un-normalized figure, which is
   *  the like-for-like unit: GitHub reports raw minutes per SKU, not
   *  Linux-equivalents. */
  meteredMinutes: number;
  /** Σ minutes GitHub's own usage report attributes to the repo. */
  reportedMinutes: number;
  /** metered − reported. Negative means the meter UNDER-counted (the direction a
   *  missed webhook produces). */
  driftMinutes: number;
  /** True when |drift| exceeds the stated tolerance. */
  exceedsTolerance: boolean;
}

export type ReconcileOutcome =
  | { outcome: 'skipped'; reason: 'metering_disabled' | 'no_billing_credential' }
  | {
      outcome: 'reconciled';
      org: string;
      year: number;
      month: number;
      repos: RepoReconciliation[];
      /** Repos whose drift exceeded the tolerance — what the job logs. */
      discrepancies: RepoReconciliation[];
    };

/** GitHub's Actions SKUs are labelled "Actions Linux", "Actions Windows", … —
 *  the compute lines, as opposed to storage/packages lines in the same report. */
function isActionsComputeLine(sku: string, unitType: string): boolean {
  return sku.toLowerCase().includes('actions') && unitType.toLowerCase().includes('minute');
}

/** The tolerance for one repo's reported total (§5.8; the constants and their
 *  reasoning live in `lib/ciMetering/config.ts`). */
export function toleranceFor(reportedMinutes: number): number {
  return Math.max(
    RECONCILIATION_TOLERANCE_FLOOR_MINUTES,
    reportedMinutes * RECONCILIATION_TOLERANCE_FRACTION,
  );
}

/**
 * Compare metered totals against a host usage report. PURE — the I/O lives in
 * the service method below, so the comparison itself is directly testable.
 *
 * Both sides are keyed by repository NAME, which is what GitHub's report carries
 * (`repositoryName`); the owner is fixed for a reconciliation because the whole
 * report is one org's.
 *
 * A repo present on ONE side only still produces a row, with the missing side at
 * zero — that asymmetry is the most valuable signal the reconciliation has. A
 * repo GitHub billed that the meter never saw means deliveries were lost; a repo
 * the meter counted that GitHub did not bill means it metered something Motir
 * was not charged for.
 */
export function reconcileTotals(
  metered: ReadonlyArray<{ repoName: string; billableMinutes: number }>,
  reported: ReadonlyArray<{
    repositoryName: string;
    sku: string;
    quantity: number;
    unitType: string;
  }>,
): RepoReconciliation[] {
  const meteredByRepo = new Map<string, number>();
  for (const row of metered) {
    meteredByRepo.set(row.repoName, (meteredByRepo.get(row.repoName) ?? 0) + row.billableMinutes);
  }

  const reportedByRepo = new Map<string, number>();
  for (const line of reported) {
    if (!isActionsComputeLine(line.sku, line.unitType)) continue;
    reportedByRepo.set(
      line.repositoryName,
      (reportedByRepo.get(line.repositoryName) ?? 0) + line.quantity,
    );
  }

  const names = [...new Set([...meteredByRepo.keys(), ...reportedByRepo.keys()])].sort();
  return names.map((repoName) => {
    const meteredMinutes = meteredByRepo.get(repoName) ?? 0;
    const reportedMinutes = reportedByRepo.get(repoName) ?? 0;
    const driftMinutes = Math.round((meteredMinutes - reportedMinutes) * 100) / 100;
    return {
      repoName,
      meteredMinutes,
      reportedMinutes,
      driftMinutes,
      exceedsTolerance: Math.abs(driftMinutes) > toleranceFor(reportedMinutes),
    };
  });
}

export const ciMinutesReconciliationService = {
  /**
   * The meter's own side of the comparison for a calendar month: per-repository
   * billable totals across every tenant, for Motir's provisioning org. Empty
   * when metering is not configured.
   */
  async meteredTotalsForMonth(
    periodStart: Date,
  ): Promise<Array<{ repoName: string; billableMinutes: number }>> {
    const org = provisioningOrgLogin();
    if (!org) return [];
    return withSystemContext((tx) =>
      ciWorkflowRunUsageRepository.sumByRepoForOwnerPeriod(
        org,
        periodStart,
        periodEndFor(periodStart),
        tx,
      ),
    );
  },

  /**
   * Reconcile the meter against GitHub's billing report for one calendar month.
   * `metered` is supplied by the caller (the job sums it across every org) so
   * this method stays a thin compose-and-compare over one host read.
   *
   * Returns `skipped` rather than throwing when there is nothing to reconcile
   * WITH: off-cloud, no provisioning org, or no org-billing credential. The last
   * is the normal state until MOTIR-1779 provisions one — the operational meter
   * does not depend on it, so a missing audit credential must never look like a
   * failure.
   */
  async reconcileMonth(
    year: number,
    month: number,
    metered: ReadonlyArray<{ repoName: string; billableMinutes: number }>,
  ): Promise<ReconcileOutcome> {
    if (!isCiMeteringEnabled()) return { outcome: 'skipped', reason: 'metering_disabled' };
    const org = provisioningOrgLogin();
    const token = billingUsageToken();
    if (!org || !token) return { outcome: 'skipped', reason: 'no_billing_credential' };

    const provider = getGitProvider(PROVIDER);
    if (!provider.fetchOrgComputeUsage) {
      return { outcome: 'skipped', reason: 'no_billing_credential' };
    }
    const reported = await provider.fetchOrgComputeUsage(org, year, month, token);
    const repos = reconcileTotals(metered, reported);
    const discrepancies = repos.filter((row) => row.exceedsTolerance);

    if (discrepancies.length > 0) {
      // LOGGED, never auto-corrected (§5.8). The meter's rows are what a charge
      // was derived from; rewriting them from a summary report would re-price
      // history the ADR requires to stay frozen (§3.3).
      console.warn('[ciMinutesReconciliation] meter drifted from GitHub billing beyond tolerance', {
        org,
        year,
        month,
        toleranceFraction: RECONCILIATION_TOLERANCE_FRACTION,
        toleranceFloorMinutes: RECONCILIATION_TOLERANCE_FLOOR_MINUTES,
        discrepancies,
      });
    }

    return { outcome: 'reconciled', org, year, month, repos, discrepancies };
  },
};
