// THE PRICE OF A HOSTED RUN'S MACHINE TIME (Story MOTIR-683 · Subtask MOTIR-6514;
// `docs/decisions/hosted-agent-machine-charge.md`).
//
// ⚠️ ONE PRICE FOR A MOTIR MACHINE MINUTE, and this file owns NONE of it. The
// credits-per-minute is CI overage's (`lib/ciMetering/allowance.ts`, the constant
// `ciAllowanceService` bills by) and the multiplier is the `motir_fleet` row of
// `lib/ciMetering/runnerRates.ts` — the same machine, the same minute, the same
// price whether an agent or a CI job holds it (decision §2). A second constant
// here would be a second price the day one of them moves;
// `tests/hostedRuns/machineRate.test.ts` greps for one.
//
// ⚠️ THE ONE DIFFERENCE FROM CI IS THE ROUNDING (decision §3). CI overage carries
// an under-a-credit remainder to its next charge; a hosted run is ONE charge, so
// it rounds up once — at most one credit per run — and a run with no billable
// seconds costs nothing.
//
// PURE: no DB, no network, no cloud check. The clock is a parameter because the
// multiplier is an effective-dated row.

import { CREDITS_PER_LINEAR_EQUIVALENT_MINUTE } from '@/lib/ciMetering/allowance';
import { LINUX_EQUIVALENT_MULTIPLIER, resolveRunnerRate } from '@/lib/ciMetering/runnerRates';

/**
 * The `motir_fleet` multiplier in force at `at`. An unresolved row falls back to
 * the Linux-equivalent 1.0, exactly as CI's `multiplierForLabels` does — never
 * to zero, which would give machine time away.
 */
export function motirFleetMultiplier(at: Date): number {
  return resolveRunnerRate('motir_fleet', at)?.multiplier ?? LINUX_EQUIVALENT_MULTIPLIER;
}

/**
 * WHOLE credits for `billableSeconds` of hosted-agent machine time:
 * `⌈billableSeconds ÷ 60 × multiplier × credits-per-minute⌉`, and `0` for a run
 * that billed no seconds. 1,592 s is 27 at today's rates.
 */
export function machineCreditsFor(billableSeconds: number, at: Date = new Date()): number {
  if (!Number.isFinite(billableSeconds) || billableSeconds <= 0) return 0;
  const minutes = (billableSeconds / 60) * motirFleetMultiplier(at);
  return Math.ceil(minutes * CREDITS_PER_LINEAR_EQUIVALENT_MINUTE);
}
