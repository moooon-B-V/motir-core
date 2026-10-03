import { withSystemContext } from '@/lib/workspaces/context';
import { ciWorkflowRunUsageRepository } from '@/lib/repositories/ciWorkflowRunUsageRepository';
import type { MeteredRunRunners } from '@/lib/repositories/ciWorkflowRunUsageRepository';
import { motirOwnedOrgLogins } from '@/lib/ciMetering/ownedOrgs';
import { MOTIR_FLEET_RUNNER_FAMILY } from '@/lib/ciMetering/runnerRates';
import type { HostedRunOffenderDTO, HostedRunProbeVerdictDTO } from '@/lib/dto/hostedRunProbe';

// THE HOSTED-RUN PROBE (MOTIR-1934) — a probe of `system.daily-health-check`
// that fails when a metered CI run in a Motir-OWNED org ran on anything other
// than Motir's own fleet.
//
// ⚠️ WHY THE $0 BUDGET IS NOT THE STOP (measured on MOTIR-1908, 2026-07-31).
// `motir-projects`' "stop usage" budget does not stop a GitHub-hosted run:
// included minutes bill at gross and are discounted to `netAmount: 0`, so the
// budget never binds. A cleared `vars.MOTIR_RUNNER` therefore runs every
// workflow on `ubuntu-latest` (MOTIR-1925's fallback) for the org's included
// private-repo minutes, and indefinitely for public repos, which leave no
// billing row at all. The meter records BOTH visibilities from `workflow_run`
// completions, so the evidence is already in `ci_workflow_run_usage`.
//
// HOSTED-NESS IS `classifyRunner()`'s, decided once. The meter stores each
// run's jobs grouped by the family `classifyRunner()` gave their labels
// (`lib/ciMetering/normalize.ts`), so this probe reads that family and asks one
// question of it — is it `MOTIR_FLEET_RUNNER_FAMILY`? — with no second copy of
// any label list. An `unknown` family (an unpriced, empty or near-miss label
// set) is NOT the fleet, so it fires: the safe direction.

/**
 * The window: one cron period. `system.daily-health-check` fires daily, so the
 * runs completed since the previous tick are the runs completed in the last 24
 * hours. A tick that never fired leaves that day unread — `catchUp: 'latest'`
 * fires once, not once per missed day — and the schedule-health probe beside
 * this one is what reports a missed tick.
 */
export const HOSTED_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The families a stored breakdown names that are not the fleet. A breakdown
 * that is not an array, or an entry without a string family, is unreadable and
 * reports as `unknown` — the same fallback the reconciliation applies (an
 * unreadable row is counted as hosted). An EMPTY array means no job ran to
 * completion, so no compute was spent and there is nothing to report.
 */
function nonFleetFamilies(breakdown: unknown): string[] {
  if (!Array.isArray(breakdown)) return ['unknown'];
  const families = new Set<string>();
  for (const entry of breakdown) {
    const family =
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { family?: unknown }).family === 'string'
        ? (entry as { family: string }).family
        : 'unknown';
    if (family !== MOTIR_FLEET_RUNNER_FAMILY) families.add(family);
  }
  return [...families].sort();
}

/** The pure verdict over a window's runs. Exported for its unit test. */
export function judgeHostedRuns(
  runs: readonly MeteredRunRunners[],
  ownedOrgs: readonly string[],
  now: Date,
  windowStart: Date,
): HostedRunProbeVerdictDTO {
  const base = {
    checkedAt: now.toISOString(),
    windowStart: windowStart.toISOString(),
    ownedOrgs: [...ownedOrgs],
    runsChecked: runs.length,
  };
  if (ownedOrgs.length === 0) return { ...base, verdict: 'not_applicable' };
  const owned = new Set(ownedOrgs.map((org) => org.toLowerCase()));
  const offenders: HostedRunOffenderDTO[] = [];
  for (const run of runs) {
    if (!owned.has(run.repoOwner.toLowerCase())) continue;
    const families = nonFleetFamilies(run.runnerBreakdown);
    if (families.length === 0) continue;
    offenders.push({
      org: run.repoOwner,
      repo: run.repoName,
      runId: run.runId,
      runAttempt: run.runAttempt,
      completedAt: run.runCompletedAt.toISOString(),
      families,
    });
  }
  return offenders.length > 0
    ? { ...base, verdict: 'hosted_runs', offenders }
    : { ...base, verdict: 'ok' };
}

export const hostedRunProbeService = {
  /**
   * Judge every metered run in a Motir-owned org completed in the last cron
   * period. Never throws on a hosted run — the caller decides which arms are
   * loud. `now` is injectable so a test never reads the wall clock.
   */
  async check(now: Date = new Date()): Promise<HostedRunProbeVerdictDTO> {
    const ownedOrgs = motirOwnedOrgLogins();
    const windowStart = new Date(now.getTime() - HOSTED_RUN_WINDOW_MS);
    if (ownedOrgs.length === 0) return judgeHostedRuns([], ownedOrgs, now, windowStart);
    const runs = await withSystemContext((tx) =>
      ciWorkflowRunUsageRepository.findCompletedSinceForOwners(ownedOrgs, windowStart, tx),
    );
    return judgeHostedRuns(runs, ownedOrgs, now, windowStart);
  },
};
