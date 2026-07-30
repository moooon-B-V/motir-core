// Turning one completed workflow run's JOBS into metered minutes (Story
// MOTIR-1775 · MOTIR-1896), implementing `docs/decisions/ci-minutes-allowance.md`
// §3 + §5.8. PURE — no I/O, no clock, no DB.
//
// ⚠️ PER-JOB ROUNDING UP IS NOT OPTIONAL (§5.8). GitHub bills **per job, rounded
// up to the minute**, and a workflow's jobs run in PARALLEL by wall clock. So the
// billable figure is the SUM OF THE JOBS, not the run's critical path:
//
//     billable = Σ_jobs ceil( (completed_at − started_at) / 60s )
//
// Summing the run's own wall clock instead would undercount a 4-job suite badly
// — the starter's CI is four parallel jobs, so its ~19 billable minutes would
// read as the ~8-minute critical path.
//
// Each job is then normalized to Linux-equivalents at ITS OWN runner's rate
// (§3.1), because one run can mix runners:
//
//     linear_equivalent = Σ_jobs ( ceil(job minutes) × multiplier(job labels) )
//
// The raw wall clock, the runner label and the applied multiplier are all
// retained per family so a later repricing needs no backfill (§3.3).

import { multiplierForLabels, type RunnerFamily } from './runnerRates';

/** One job of a completed workflow run, as the provider seam normalizes it. */
export interface MeteredJob {
  /** The host's job id — carried for the audit trail, not part of the maths. */
  id: string;
  name: string;
  startedAt: Date | null;
  completedAt: Date | null;
  /** The runner labels GitHub reports (`["ubuntu-latest"]`). */
  labels: readonly string[];
}

/** Per-runner-family breakdown, stored on the metered row so the arithmetic is
 *  auditable and a repricing can be recomputed without re-fetching GitHub. */
export interface RunnerBreakdownEntry {
  family: RunnerFamily;
  /** The multiplier ACTUALLY APPLIED (§3.3) — frozen at metering time. */
  multiplier: number;
  /** Σ ceil(per-job minutes) for this family — the billable, pre-multiplier unit. */
  billableMinutes: number;
  /** Σ raw job durations in seconds, un-rounded — the audit trail (§3.3). */
  rawWallClockSeconds: number;
  linearEquivalentMinutes: number;
  jobCount: number;
  /** True when no rate covered this family, so ×1.00 was applied (§3.4). The
   *  caller LOGS this — it is the signal to add a rate, and under-counting is the
   *  safe direction (it never over-bills for a rate nobody decided). */
  unpriced: boolean;
}

export interface NormalizedRunUsage {
  /** Σ ceil(per-job minutes) across every runner — what GitHub bills, pre-normalization. */
  billableMinutes: number;
  /** Σ raw job durations in seconds, un-rounded (§3.3 — no backfill on a repricing). */
  rawWallClockSeconds: number;
  /** The metered quantity: Σ (billable × multiplier), rounded to 2dp. */
  linearEquivalentMinutes: number;
  /** Jobs that actually contributed (a job missing either timestamp is skipped). */
  jobCount: number;
  breakdown: RunnerBreakdownEntry[];
  /** Every family metered at the §3.4 fallback — the caller logs these. */
  unpricedFamilies: RunnerFamily[];
}

/** Minutes GitHub bills for one job: its wall clock, rounded UP (§5.8). A job
 *  missing either timestamp never ran to completion and contributes nothing. */
function billableMinutesFor(job: MeteredJob): { minutes: number; seconds: number } | null {
  if (!job.startedAt || !job.completedAt) return null;
  const ms = job.completedAt.getTime() - job.startedAt.getTime();
  // A negative or non-finite span is a malformed payload, not a credit: skip it
  // rather than let it subtract from a real job's minutes.
  if (!Number.isFinite(ms) || ms < 0) return null;
  return { minutes: Math.ceil(ms / 60_000), seconds: ms / 1000 };
}

/** Round to 2dp, the precision the `Decimal(12, 2)` columns store. Applied at
 *  the AGGREGATE, never per job, so repeated rounding cannot accumulate drift. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Normalize one run's jobs into the metered quantities. `completedAt` is the
 * run's completion instant and selects the EFFECTIVE-DATED rate (§3.3) — a run
 * is always priced at the rates in force when it ran, never at today's.
 */
export function normalizeRunUsage(
  jobs: readonly MeteredJob[],
  completedAt: Date,
): NormalizedRunUsage {
  const byFamily = new Map<RunnerFamily, RunnerBreakdownEntry>();

  for (const job of jobs) {
    const billable = billableMinutesFor(job);
    if (!billable) continue;
    const { family, multiplier, priced } = multiplierForLabels(job.labels, completedAt);

    let entry = byFamily.get(family);
    if (!entry) {
      entry = {
        family,
        multiplier,
        billableMinutes: 0,
        rawWallClockSeconds: 0,
        linearEquivalentMinutes: 0,
        jobCount: 0,
        unpriced: !priced,
      };
      byFamily.set(family, entry);
    }
    entry.billableMinutes += billable.minutes;
    entry.rawWallClockSeconds += billable.seconds;
    entry.jobCount += 1;
  }

  const breakdown: RunnerBreakdownEntry[] = [];
  let billableMinutes = 0;
  let rawWallClockSeconds = 0;
  let linearEquivalentMinutes = 0;
  const unpricedFamilies: RunnerFamily[] = [];

  for (const entry of byFamily.values()) {
    entry.linearEquivalentMinutes = round2(entry.billableMinutes * entry.multiplier);
    entry.rawWallClockSeconds = round2(entry.rawWallClockSeconds);
    billableMinutes += entry.billableMinutes;
    rawWallClockSeconds += entry.rawWallClockSeconds;
    linearEquivalentMinutes += entry.billableMinutes * entry.multiplier;
    if (entry.unpriced) unpricedFamilies.push(entry.family);
    breakdown.push(entry);
  }

  // Deterministic order — the breakdown is persisted as JSON and asserted on.
  breakdown.sort((a, b) => a.family.localeCompare(b.family));

  return {
    billableMinutes,
    rawWallClockSeconds: round2(rawWallClockSeconds),
    linearEquivalentMinutes: round2(linearEquivalentMinutes),
    jobCount: breakdown.reduce((sum, entry) => sum + entry.jobCount, 0),
    breakdown,
    unpricedFamilies,
  };
}
