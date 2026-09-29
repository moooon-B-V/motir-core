import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import {
  ciRunnerProvisioningIntentRepository as intents,
  CI_RUNNER_INTENT_IN_FLIGHT,
} from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { ciLiveAccrualRepository } from '@/lib/repositories/ciLiveAccrualRepository';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { fleetStopService } from '@/lib/services/fleetStopService';
import { isCiMeteringEnabled } from '@/lib/ciMetering/config';
import { periodStartFor } from '@/lib/ciMetering/period';
import { CI_DEBIT_PERIOD_MINUTES } from '@/lib/ciMetering/allowance';

// CI IS DEBITED WHILE IT RUNS (Story MOTIR-6906 · MOTIR-6910) —
// `docs/decisions/fleet-per-org-pool.md` §3.
//
// Before this, a CI run was charged once, when GitHub's `workflow_run` webhook
// said it had finished. A long or runaway job spent freely until then, and the
// balance any stop would read was always behind. Every debit period this tick
// adds each live CI container's WHOLE minutes since its last tick to the org's
// `ci_period_usage` rollup, then hands the org to the SHIPPED charge
// (`ciAllowanceService.chargeForMeteredRun`): included minutes first, then
// credits through the existing `ci_overage` debit, with its watermark ref, its
// sub-credit carry and its pending-debit retry. Nothing about pricing is decided
// here; this only makes the consumption arrive while the container still runs.
//
// ⚠️ NO MINUTE IS COUNTED TWICE, and three things make that true:
//
//   1. THE CHECKPOINT IS A SUM, NOT A CLOCK. A tick adds (whole minutes since
//      the job started) − (what this container's rows already hold), read under
//      the intent's row lock. A late tick, a skipped tick or two overlapping
//      ticks all converge on the same total.
//   2. `(intent, period)` IS UNIQUE. A replayed or retried tick finds its row
//      and adds nothing to the rollup, which shares the transaction.
//   3. THE COMPLETION METER RECONCILES. When the run ends,
//      `ciMinutesMeterService.meterWorkflowRun` subtracts this run's live sum
//      from GitHub's figure and adds only the difference — so the minutes GitHub
//      bills that the ticks never saw (the partial last minute, per-job
//      rounding) are charged once, at the end, as they are today.
//
// ⚠️ WHOLE MINUTES ONLY. A tick never charges a partial minute: the remainder
// waits for the next tick or for the end-of-run meter, so no container pays more
// than it did when it was charged only at the end (§3).
//
// ⚠️ COMMIT, THEN EFFECT (`docs/jobs.md`). The accrual commits first; the debit
// crosses into motir-ai after, inside `chargeForMeteredRun`, which already books
// locally before it debits. A motir-ai outage leaves the minutes accrued and the
// debit pending, and the next tick that meters something retries it (§3: "a tick
// that cannot reach motir-ai stops nothing already running, keeps the accrual,
// and charges it on the next tick that can").

/** The debit period (§3). The job's cron fires on the same boundary. */
export const LIVE_CHARGE_PERIOD_MS = CI_DEBIT_PERIOD_MINUTES * 60_000;

/** The start of the debit period containing `at` — the idempotency key's clock. */
export function tickStartFor(at: Date): Date {
  return new Date(Math.floor(at.getTime() / LIVE_CHARGE_PERIOD_MS) * LIVE_CHARGE_PERIOD_MS);
}

/** What one tick charged one organisation. `charge` is the shipped charge's
 *  outcome, or `charge_failed` when it threw. */
export interface LiveChargeOrgResult {
  organizationId: string;
  accruedMinutes: number;
  charge: string;
}

export type LiveChargeTickResult =
  /** Off-cloud, or no provisioning org — the CI meter is inert (§8.5). */
  | { outcome: 'disabled' }
  | {
      outcome: 'ticked';
      tickStart: string;
      /** Live CI containers whose job had started. */
      containers: number;
      /** Of those, how many added minutes this tick. */
      accrued: number;
      /** Containers whose accrual threw — logged, retried next tick. */
      failures: number;
      organizations: LiveChargeOrgResult[];
      /** Organisations this tick found at zero and stopped (MOTIR-6911). */
      stopped: string[];
    };

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

export const ciLiveChargeService = {
  /**
   * One debit period: accrue every live CI container, then charge each org that
   * accrued something. Never throws for one container or one org — a failure is
   * logged and the next tick picks it up, because the checkpoint is a sum.
   */
  async tick(now: Date): Promise<LiveChargeTickResult> {
    if (!isCiMeteringEnabled()) return { outcome: 'disabled' };

    const tickStart = tickStartFor(now);
    const periodStart = periodStartFor(now);
    const live = await withSystemContext((tx) => intents.listStartedInFlight(tx));

    const byOrg = new Map<string, number>();
    let accrued = 0;
    let failures = 0;
    for (const intent of live) {
      try {
        const minutes = await this.accrueContainer(intent, { now, tickStart, periodStart });
        if (minutes > 0) {
          accrued += 1;
          byOrg.set(intent.organizationId, (byOrg.get(intent.organizationId) ?? 0) + minutes);
        }
      } catch (err) {
        failures += 1;
        console.error('[ciLiveChargeService] could not accrue a live CI container', {
          intentId: intent.id,
          organizationId: intent.organizationId,
          detail: detailOf(err),
        });
      }
    }

    const organizations: LiveChargeOrgResult[] = [];
    for (const [organizationId, accruedMinutes] of byOrg) {
      organizations.push({
        organizationId,
        accruedMinutes,
        charge: await this.chargeOrganization(organizationId, periodStart),
      });
    }

    // ── AT ZERO, THE ORG STOPS (§3–§4, MOTIR-6911) — in the same tick ─────────
    // Every org still running a container, not only those that accrued a whole
    // minute this tick: an org already at zero with a container a few seconds old
    // must not wait a period for its first minute.
    const stopped: string[] = [];
    for (const organizationId of new Set(live.map((intent) => intent.organizationId))) {
      if (await this.stopIfAtZero(organizationId, now)) stopped.push(organizationId);
    }

    return {
      outcome: 'ticked',
      tickStart: tickStart.toISOString(),
      containers: live.length,
      accrued,
      failures,
      organizations,
      stopped,
    };
  },

  /**
   * Add ONE container's whole minutes since its last accrual to its org's rollup,
   * and record them. Answers the minutes added (0 for a replay, a container that
   * settled since the listing, or one with less than a new whole minute).
   */
  async accrueContainer(
    intent: CiRunnerProvisioningIntent,
    at: { now: Date; tickStart: Date; periodStart: Date },
  ): Promise<number> {
    return withSystemContext(async (tx) => {
      const locked = await intents.lockForAccrual(intent.id, tx);
      // Settled between the listing and the lock: the completion meter owns it.
      if (!locked || !locked.startedAt || !CI_RUNNER_INTENT_IN_FLIGHT.includes(locked.status)) {
        return 0;
      }

      const elapsedSeconds = Math.floor((at.now.getTime() - locked.startedAt.getTime()) / 1000);
      const wholeSeconds = Math.max(0, Math.floor(elapsedSeconds / 60) * 60);
      const already = await ciLiveAccrualRepository.sumSecondsForIntent(intent.id, tx);
      const deltaSeconds = wholeSeconds - already;
      if (deltaSeconds <= 0) return 0;

      const written = await ciLiveAccrualRepository.create(
        {
          provisioningIntentId: intent.id,
          organizationId: intent.organizationId,
          workspaceId: intent.workspaceId,
          runId: intent.runId,
          runAttempt: intent.runAttempt,
          tickStart: at.tickStart,
          periodStart: at.periodStart,
          accruedSeconds: deltaSeconds,
        },
        tx,
      );
      // This period already has its row — a replayed tick. Nothing to add.
      if (!written) return 0;

      const minutes = deltaSeconds / 60;
      // The fleet's runner is priced at ×1.00 (`ci-minutes-allowance.md` §M), so
      // a container minute is one Linux-equivalent minute and one billable one.
      await ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId: intent.workspaceId,
          organizationId: intent.organizationId,
          periodStart: at.periodStart,
          billableMinutes: minutes,
          rawWallClockSeconds: deltaSeconds,
          linearEquivalentMinutes: minutes,
          // The run is counted once, by the completion meter.
          countsRun: false,
        },
        tx,
      );
      return minutes;
    });
  },

  /**
   * Charge ONE org for what is now in its rollup, through the shipped charge.
   * The meta org is measured and never charged, as on the completion path.
   */
  async chargeOrganization(organizationId: string, periodStart: Date): Promise<string> {
    try {
      const isMeta = await withOrgServiceWriteContext(organizationId, async (tx) => {
        const org = await organizationRepository.findByIdInTx(organizationId, tx);
        // A missing row charges rather than bypasses — the safe direction, as the
        // completion meter does.
        return org?.isMeta ?? false;
      });
      const result = await ciAllowanceService.chargeForMeteredRun({
        organizationId,
        periodStart,
        isMeta,
      });
      return result.outcome;
    } catch (err) {
      console.error('[ciLiveChargeService] could not charge an organization — retried next tick', {
        organizationId,
        detail: detailOf(err),
      });
      return 'charge_failed';
    }
  },

  /**
   * Stop ONE org's fleet if this period's debit left it at zero: its included
   * minutes spent and its balance ≤ 0 — the shipped `ci_credits_exhausted`
   * state, read through the same service the billing panel and the Actions pause
   * read, so all three agree on when an org is at zero. The Actions pause
   * (`ciActionsGateService`) converges from that same state as it does today.
   *
   * ⚠️ AN UNREADABLE BALANCE STOPS NOTHING (§3). `resolveState` answers a null
   * balance as not exhausted, and that is the property wanted here: stopping
   * every org's running CI because motir-ai is down is the outage the record
   * refuses to cause. New work is refused at admission instead.
   *
   * Never throws: a failed read or a failed stop is logged and the next tick
   * decides again — `stopOrganization` is idempotent.
   */
  async stopIfAtZero(organizationId: string, now: Date): Promise<boolean> {
    try {
      const state = await ciAllowanceService.getEntitlementState(organizationId, now);
      if (state.state !== 'ci_credits_exhausted') return false;
      const result = await fleetStopService.stopOrganization(organizationId, 'credits_exhausted');
      console.warn('[ciLiveChargeService] an organization reached zero — its fleet was stopped', {
        organizationId,
        ...result,
      });
      return true;
    } catch (err) {
      console.error(
        '[ciLiveChargeService] could not stop an organization at zero — retried next tick',
        {
          organizationId,
          detail: detailOf(err),
        },
      );
      return false;
    }
  },
};
