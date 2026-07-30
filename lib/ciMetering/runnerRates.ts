// The runner-normalization policy for the CI-minutes meter (Story MOTIR-1775 ·
// MOTIR-1896), implementing `docs/decisions/ci-minutes-allowance.md` §3.
//
// The pool is denominated in LINEAR-EQUIVALENT minutes:
//
//     linear_equivalent = raw_billable_minutes × multiplier(runner)
//
// and the multiplier is a PRICE RATIO — the runner's own per-minute price
// divided by the Linux 2-core x64 price (the numéraire) — NOT GitHub's
// `Linux ×1 / Windows ×2 / macOS ×10` included-minutes drain multipliers. ADR
// §3.2 is explicit that those are a marketing allotment device rather than a
// cost signal: adopting them would overcharge Windows by 20% (×2 implies
// $0.012 against a real $0.010) and undercharge macOS by 3% (×10 implies
// $0.060 against a real $0.062). This is the shipped `ModelCreditRate` rule one
// domain over — Motir already prices AI cost-plus from each provider's own
// price, and `notes.html` #88 is the recorded lesson from taking a rate off a
// secondary catalog instead of the vendor's own page.
//
// ⚠️ EFFECTIVE-DATED, not a bare constant (ADR §3.3). Each entry carries an
// `effectiveFrom`, and resolution takes the run's own completion timestamp — so
// a GitHub repricing is a NEW ENTRY, never a backfill, and already-metered
// history never silently re-prices. Every metered row additionally stores the
// runner label AND the multiplier it applied, so a rate change cannot rewrite
// what was already counted.
//
// WHY a pure module rather than a DB table: the ADR describes the shape as
// "a table with an `effectiveFrom`, mirroring `ModelCreditRate`'s
// `(model, effectiveFrom)` shape". This ships that SHAPE as pure config,
// deliberately, for the reason §4.5 gives for the period key — the meter must
// resolve a `workflow_run` delivery WITHOUT reading any other state, keeping the
// hot webhook path a single insert and the open-core meter free of commercial
// coupling. It also mirrors §8.4's instruction for the sibling's entitlement
// policy ("pure config + a resolver, no DB, no Stripe, no cloud check"). The
// resolver's signature is the table's read signature, so promoting this to rows
// later is mechanical and needs no call-site change.

/** The runner families the ADR prices. `unknown` is the safe catch-all (§3.4). */
export type RunnerFamily = 'linux_x64' | 'linux_arm64' | 'windows_x64' | 'macos' | 'unknown';

/** One effective-dated price ratio for a runner family. */
export interface RunnerRate {
  family: RunnerFamily;
  /** The runner's price ÷ the Linux 2-core x64 price, at `effectiveFrom`. */
  multiplier: number;
  /** UTC instant this rate takes effect. A run completing before it uses the
   *  previous entry for the same family (none today — these are the first). */
  effectiveFrom: Date;
  /** The vendor price the ratio was computed from, in USD per minute — recorded
   *  so the arithmetic is auditable without re-reading the ADR. */
  usdPerMinute: number;
}

/** GitHub's 2026-01-01 Actions repricing — the cut that took Linux 2-core from
 *  $0.008 to $0.006 and folded the $0.002/min platform charge into the meter
 *  rates (ADR §9). Every rate below is dated to it because that is when the
 *  prices they are ratios of took effect. */
const GITHUB_2026_REPRICING = new Date('2026-01-01T00:00:00.000Z');

/**
 * The effective-dated rate table (ADR §3.1). Ordered newest-last per family;
 * `resolveRunnerRate` picks the latest entry whose `effectiveFrom` is at or
 * before the run's completion. ADDING a repricing = appending an entry with the
 * new `effectiveFrom`, never editing one in place.
 */
export const RUNNER_RATES: readonly RunnerRate[] = [
  {
    family: 'linux_x64',
    multiplier: 1.0,
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.006,
  },
  {
    family: 'linux_arm64',
    multiplier: 0.83, // $0.005 / $0.006
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.005,
  },
  {
    family: 'windows_x64',
    multiplier: 1.67, // $0.010 / $0.006
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.01,
  },
  {
    family: 'macos',
    multiplier: 10.33, // $0.062 / $0.006
    effectiveFrom: GITHUB_2026_REPRICING,
    usdPerMinute: 0.062,
  },
];

/** The numéraire's multiplier — also the fallback for an unpriced runner (§3.4). */
export const LINUX_EQUIVALENT_MULTIPLIER = 1.0;

/** A larger/xlarge runner: GitHub's hosted-runner labels carry an explicit core
 *  count (`ubuntu-latest-4-core`, `windows-latest-8-core`) or an `xlarge` size,
 *  and those bill at HIGHER per-minute prices the ADR does not price. They are
 *  deliberately classified `unknown` rather than folded into the 2-core rate —
 *  see `classifyRunner`. */
const LARGER_RUNNER = /(^|-)(\d+-?core|xlarge|large)(-|$)/i;

/**
 * Classify a job's runner from its GitHub `labels` (and, as a weaker hint, its
 * `runner_name`). PURE.
 *
 * The ADR prices the FOUR standard 2-core hosted runners. Anything else — a
 * larger hosted runner, a self-hosted label, a future OS — is `unknown`, which
 * §3.4 meters at ×1.00 and LOGS: under-counting a runner Motir has not priced is
 * the safe direction (it never over-bills a user for a rate nobody decided), and
 * the log entry is the signal to add a rate.
 *
 * Note the larger-runner check runs BEFORE the OS match on purpose: an
 * `ubuntu-latest-4-core` job is Linux, but it is NOT the Linux the ×1.00 rate
 * prices, and silently charging it as one would be a priced guess.
 */
export function classifyRunner(labels: readonly string[]): RunnerFamily {
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (label.length === 0) continue;
    if (LARGER_RUNNER.test(label)) return 'unknown';
    if (label.includes('macos') || label.includes('osx')) return 'macos';
    if (label.includes('windows')) return 'windows_x64';
    if (label.includes('arm')) return 'linux_arm64';
    if (label.includes('ubuntu') || label.includes('linux')) return 'linux_x64';
  }
  return 'unknown';
}

/**
 * The rate in force for `family` at instant `at` — the latest entry whose
 * `effectiveFrom <= at`. Returns null when the family is unpriced (`unknown`),
 * or when the run predates every entry for it; the caller then applies
 * `LINUX_EQUIVALENT_MULTIPLIER` and logs (§3.4).
 */
export function resolveRunnerRate(family: RunnerFamily, at: Date): RunnerRate | null {
  let best: RunnerRate | null = null;
  for (const rate of RUNNER_RATES) {
    if (rate.family !== family) continue;
    if (rate.effectiveFrom.getTime() > at.getTime()) continue;
    if (best === null || rate.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = rate;
  }
  return best;
}

/** The multiplier to APPLY for a job, plus whether it fell back — the caller
 *  stores the multiplier on the metered row and logs when `priced` is false. */
export interface ResolvedMultiplier {
  family: RunnerFamily;
  multiplier: number;
  /** False when no rate covered the family at that instant (the §3.4 fallback). */
  priced: boolean;
}

/** Resolve the multiplier for a job's labels at a completion instant (§3.1/§3.4). */
export function multiplierForLabels(labels: readonly string[], at: Date): ResolvedMultiplier {
  const family = classifyRunner(labels);
  const rate = resolveRunnerRate(family, at);
  if (!rate) return { family, multiplier: LINUX_EQUIVALENT_MULTIPLIER, priced: false };
  return { family, multiplier: rate.multiplier, priced: true };
}
