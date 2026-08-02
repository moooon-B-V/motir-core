import { getGitProvider } from '@/lib/git';
import type { GitProviderId } from '@/lib/git/types';
import { withSystemContext } from '@/lib/workspaces/context';
import { ciWorkflowRunUsageRepository } from '@/lib/repositories/ciWorkflowRunUsageRepository';
import {
  ciContainerUsageRepository,
  type RepoContainerTotal,
} from '@/lib/repositories/ciContainerUsageRepository';
import { periodEndFor } from '@/lib/ciMetering/period';
import { MOTIR_FLEET_RUNNER_FAMILY } from '@/lib/ciMetering/runnerRates';
import {
  billingUsageToken,
  isCiMeteringEnabled,
  provisioningOrgLogin,
  FLEET_RECONCILIATION_PER_CONTAINER_TOLERANCE_MINUTES,
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
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ TWO SUBSTRATES, TWO REPORTS, TWO RECONCILIATIONS (§Q, MOTIR-1924)
// ═══════════════════════════════════════════════════════════════════════════
//
// The audit above was written when every metered minute was a GitHub-BILLED
// minute. Since the fleet (§J–§Q), most are not: a fleet-run job costs GitHub
// nothing, so the enhanced-billing usage endpoint reports ~0 for it while the
// meter keeps counting a full month. Pointed at the whole population, the audit
// would flag EVERY repo EVERY month at ~100% drift — and a signal that always
// fires is not a signal; it is training to ignore the one thing that would catch
// a real metering bug. §Q.4 says it outright: zero GitHub-billed minutes on a
// repo is now the SUCCESS condition, not a discrepancy.
//
// So the population is split by the runner family already stored on every
// metered row (§3.3), and each half is audited against the source that actually
// knows about it:
//
//   * GITHUB-HOSTED minutes  → GitHub's billing report      (`reconcileMonth`)
//   * FLEET minutes          → the container-seconds record (`reconcileFleetMonth`)
//
// Narrowed, not disabled: a genuine mismatch on either side still reports drift,
// and the fleet half needs no billing credential at all, so it audits from the
// first fleet job onward.

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

/** One repository's fleet audit for a period: the customer-facing meter's fleet
 *  minutes against the orchestrator's own container record (§Q.2). */
export interface FleetRepoReconciliation {
  repoName: string;
  /** Σ billable minutes the meter attributed to the `motir_fleet` family. */
  meteredMinutes: number;
  /** Σ container billable SECONDS, expressed in minutes for a like-for-like
   *  comparison (the container record's own unit is seconds — §5). */
  containerMinutes: number;
  containerCount: number;
  /** How many jobs the meter saw on the fleet — one container each, if every
   *  container was recorded. A gap between this and `containerCount` is the
   *  §5 invariant ("exactly one usage row per provisioned handle") failing. */
  fleetJobCount: number;
  /** container − metered. POSITIVE means containers ran longer than the jobs
   *  they served (boot, pickup, teardown — or a leak); NEGATIVE means the meter
   *  counted fleet time no container accounts for. */
  driftMinutes: number;
  exceedsTolerance: boolean;
}

export type FleetReconcileOutcome =
  /** Off-cloud or no provisioning org — there is no fleet to audit. Note the
   *  ABSENT third reason: this half needs NO billing credential, which is why it
   *  works from the first fleet job rather than from MOTIR-1779. */
  | { outcome: 'skipped'; reason: 'metering_disabled' }
  | {
      outcome: 'reconciled';
      org: string;
      periodStart: Date;
      repos: FleetRepoReconciliation[];
      discrepancies: FleetRepoReconciliation[];
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

/** Round to 2dp — the precision the metered columns store, and enough for a
 *  comparison whose tolerance is measured in whole minutes. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The tolerance for one repo's FLEET comparison (§Q.2): the shared
 * fraction-and-floor, PLUS a per-container allowance for the two bounded,
 * expected divergences (`lib/ciMetering/config.ts` states them).
 *
 * Symmetric, deliberately. The per-job `ceil` pushes the METER up and the
 * boot/teardown bracket pushes the CONTAINER up, both by up to about a minute
 * per container, and which one dominates depends on how long the repo's jobs
 * are — a rule that flagged one direction sooner would fire on nothing but job
 * length. What it must still catch, and does, is a difference that does not
 * scale with the container count: a missing usage row, or a container that ran
 * long after its job.
 */
export function fleetToleranceFor(meteredMinutes: number, containerCount: number): number {
  return (
    Math.max(
      RECONCILIATION_TOLERANCE_FLOOR_MINUTES,
      meteredMinutes * RECONCILIATION_TOLERANCE_FRACTION,
    ) +
    containerCount * FLEET_RECONCILIATION_PER_CONTAINER_TOLERANCE_MINUTES
  );
}

/**
 * Compare the meter's FLEET minutes against the orchestrator's container record.
 * PURE — the I/O lives in the service methods below.
 *
 * Both sides are keyed by repository NAME: the metered rows carry
 * `repo_name`, and the container rows carry a `owner/name` the repository read
 * splits, so the two meet on the same key the GitHub-side audit uses.
 *
 * A repo present on ONE side only still produces a row, and here that asymmetry
 * is the MOST valuable signal the fleet audit has — more so than on the GitHub
 * side, because both of these are Motir's OWN records of Motir's OWN
 * infrastructure and they have no honest reason to disagree. Fleet minutes with
 * no containers means usage rows were lost (or containers were never recorded —
 * §5's invariant); containers with no fleet minutes means compute ran for a run
 * the meter never saw.
 */
export function reconcileFleetTotals(
  metered: ReadonlyArray<{ repoName: string; fleetMinutes: number; fleetJobCount: number }>,
  containers: ReadonlyArray<RepoContainerTotal>,
): FleetRepoReconciliation[] {
  const meteredByRepo = new Map<string, { minutes: number; jobCount: number }>();
  for (const row of metered) {
    // A repo whose month contains NO fleet minutes is not part of this audit at
    // all — it belongs entirely to the GitHub-billed half. Skipping it here is
    // what stops a purely GitHub-hosted repo appearing as a fleet row with zero
    // on both sides.
    if (row.fleetMinutes <= 0 && row.fleetJobCount <= 0) continue;
    const entry = meteredByRepo.get(row.repoName) ?? { minutes: 0, jobCount: 0 };
    entry.minutes += row.fleetMinutes;
    entry.jobCount += row.fleetJobCount;
    meteredByRepo.set(row.repoName, entry);
  }

  const containersByRepo = new Map<string, { seconds: number; count: number }>();
  for (const row of containers) {
    const entry = containersByRepo.get(row.repoName) ?? { seconds: 0, count: 0 };
    entry.seconds += row.billableSeconds;
    entry.count += row.containerCount;
    containersByRepo.set(row.repoName, entry);
  }

  const names = [...new Set([...meteredByRepo.keys(), ...containersByRepo.keys()])].sort();
  return names.map((repoName) => {
    const meteredEntry = meteredByRepo.get(repoName) ?? { minutes: 0, jobCount: 0 };
    const containerEntry = containersByRepo.get(repoName) ?? { seconds: 0, count: 0 };
    const meteredMinutes = round2(meteredEntry.minutes);
    const containerMinutes = round2(containerEntry.seconds / 60);
    const driftMinutes = round2(containerMinutes - meteredMinutes);
    return {
      repoName,
      meteredMinutes,
      containerMinutes,
      containerCount: containerEntry.count,
      fleetJobCount: meteredEntry.jobCount,
      driftMinutes,
      exceedsTolerance:
        Math.abs(driftMinutes) > fleetToleranceFor(meteredMinutes, containerEntry.count),
    };
  });
}

export const ciMinutesReconciliationService = {
  /**
   * The GITHUB-BILLED side of the meter for a calendar month: per-repository
   * billable totals across every tenant, for Motir's provisioning org, counting
   * ONLY minutes whose runner family is GitHub-hosted.
   *
   * ⚠️ THE EXCLUSION IS THE POINT (§Q.1), and the rename says so at every call
   * site. This used to be every metered minute, which was right while GitHub ran
   * every job; comparing fleet minutes against a report that never billed them
   * would flag ~100% drift on every fleet repo, every month. Fleet minutes are
   * not dropped — they are audited by {@link reconcileFleetMonth} against a
   * source that knows about them.
   *
   * Empty when metering is not configured.
   */
  async githubHostedTotalsForMonth(
    periodStart: Date,
  ): Promise<Array<{ repoName: string; billableMinutes: number }>> {
    const split = await this.hostingSplitForMonth(periodStart);
    return split
      .filter((row) => row.githubHostedMinutes > 0)
      .map((row) => ({ repoName: row.repoName, billableMinutes: row.githubHostedMinutes }));
  },

  /**
   * The month's metered minutes for Motir's provisioning org, split by who ran
   * the compute — the one read both halves of the audit are derived from, so
   * they can never disagree about which minutes belong to which population.
   */
  async hostingSplitForMonth(periodStart: Date) {
    const org = provisioningOrgLogin();
    if (!org) return [];
    return withSystemContext((tx) =>
      ciWorkflowRunUsageRepository.sumByRunnerHostingForOwnerPeriod(
        org,
        periodStart,
        periodEndFor(periodStart),
        MOTIR_FLEET_RUNNER_FAMILY,
        tx,
      ),
    );
  },

  /** The orchestrator's own record for the month, per repository — the fleet
   *  audit's second source (§Q.2). Empty when metering is not configured. */
  async containerTotalsForMonth(periodStart: Date): Promise<RepoContainerTotal[]> {
    const org = provisioningOrgLogin();
    if (!org) return [];
    return withSystemContext((tx) =>
      ciContainerUsageRepository.sumByRepoForOwnerPeriod(
        org,
        periodStart,
        periodEndFor(periodStart),
        tx,
      ),
    );
  },

  /**
   * Audit the FLEET half of the meter against the container-seconds record for
   * one calendar month (§Q.2) — the audit that replaces the phantom drift the
   * GitHub billing report would otherwise produce for every fleet repo.
   *
   * Unlike {@link reconcileMonth} it needs NO billing credential and makes no
   * host call: both sides are Motir's own tables. It therefore audits from the
   * first fleet job onward, rather than from whenever an org-billing token is
   * provisioned.
   *
   * Drift is LOGGED, never auto-corrected — the same posture, and the same
   * reason: the meter's rows are what a charge was derived from, and the
   * container record is a measurement of different spans, not a better copy of
   * the same one.
   */
  async reconcileFleetMonth(periodStart: Date): Promise<FleetReconcileOutcome> {
    if (!isCiMeteringEnabled()) return { outcome: 'skipped', reason: 'metering_disabled' };
    const org = provisioningOrgLogin();
    if (!org) return { outcome: 'skipped', reason: 'metering_disabled' };

    const [split, containers] = await Promise.all([
      this.hostingSplitForMonth(periodStart),
      this.containerTotalsForMonth(periodStart),
    ]);
    const repos = reconcileFleetTotals(split, containers);
    const discrepancies = repos.filter((row) => row.exceedsTolerance);

    if (discrepancies.length > 0) {
      console.warn(
        '[ciMinutesReconciliation] fleet meter drifted from the container record beyond tolerance',
        {
          org,
          periodStart: periodStart.toISOString(),
          toleranceFraction: RECONCILIATION_TOLERANCE_FRACTION,
          toleranceFloorMinutes: RECONCILIATION_TOLERANCE_FLOOR_MINUTES,
          perContainerToleranceMinutes: FLEET_RECONCILIATION_PER_CONTAINER_TOLERANCE_MINUTES,
          discrepancies,
        },
      );
    }

    return { outcome: 'reconciled', org, periodStart, repos, discrepancies };
  },

  /**
   * Reconcile the GITHUB-BILLED half of the meter against GitHub's billing
   * report for one calendar month.
   *
   * ⚠️ `metered` MUST be the GitHub-hosted subset — {@link githubHostedTotalsForMonth},
   * which is what the job passes. Handing it every metered minute is the §Q
   * failure this card removed: fleet minutes have no line in this report, so
   * they would read as ~100% drift on every repo that uses the fleet. The
   * argument stays caller-supplied (the job composes the read) so this method
   * remains a thin compose-and-compare over one host read.
   *
   * Returns `skipped` rather than throwing when there is nothing to reconcile
   * WITH: off-cloud, no provisioning org, or no org-billing credential. The last
   * is the normal state until MOTIR-1779 provisions one — the operational meter
   * does not depend on it, so a missing audit credential must never look like a
   * failure. The FLEET half has no such dependency ({@link reconcileFleetMonth}).
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
