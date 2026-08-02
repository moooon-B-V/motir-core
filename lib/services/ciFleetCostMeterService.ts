import { Prisma } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import {
  ciContainerUsageRepository,
  type CiContainerUsageCreateInput,
} from '@/lib/repositories/ciContainerUsageRepository';
import {
  ciContainerPeriodCostRepository,
  type OrgPeriodContainerCost,
} from '@/lib/repositories/ciContainerPeriodCostRepository';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { isCloudBilling } from '@/lib/billing/availability';
import { periodStartFor } from '@/lib/ciMetering/period';
import type { ContainerUsage } from '@/lib/orchestrator/types';

// The FLEET COST METER (Story MOTIR-1916 · MOTIR-1924) — the SECOND meter, and
// the first thing in Motir that measures what Motir's own compute costs.
//
// `docs/decisions/ci-minutes-allowance.md` §P states the problem this closes:
// before the fleet, "what the customer is charged" and "what Motir pays" were
// one number seen from two sides, because GitHub billed Motir for the minute it
// charged the user for. On Motir's own runners they are independent, and only
// the first was measured — the 9.0 gateway meters TOKENS, `ciMinutesMeterService`
// meters Actions job WALL-CLOCK, and neither sees a container. This service
// persists the container-seconds record the orchestrator emits (`ci-runner-fleet.md`
// §5), attributed the same way the minutes are, so margin per org is a number
// that can be read rather than inferred.
//
// ⚠️ IT IS NOT BILLING, AND MUST NOT BECOME IT. Nothing here debits a credit
// ledger, reads a balance, refuses anything or reaches a user-facing surface.
// This is Motir's own COGS: the customer is metered by §3's Linux-equivalent
// minutes at the ×1.00 fleet rate (§M), a PRODUCT decision that this meter's
// numbers deliberately do not feed back into. What it DOES enable is §L's margin
// claim becoming a measurement, which is the stated precondition for ever
// re-opening the allowance (§1) — in the open, with evidence, and with its own
// card.
//
// The pipeline, and where each step is decided:
//
//   1. Enabled?         §8.5  — off-cloud there is no fleet and no meter.
//   2. Meta org?        §4.4  — the internal dogfood org is bypassed entirely.
//   3. Already seen?    §5    — a cheap pre-check; the unique index is the guard.
//   4. Record it.       §4.5  — one transaction: the per-runner row + the rollup.

export type RecordContainerUsageOutcome =
  /** Off-cloud — the fleet does not run and the meter is inert (§8.5). */
  | { outcome: 'disabled' }
  /** The META org (moooon B.V.) — no pool accounting, and no COGS attribution
   *  either: moooon pays this infrastructure bill directly (§4.4). */
  | { outcome: 'bypassed_meta'; organizationId: string }
  /** This container's cost was already recorded — counted once (§5). */
  | { outcome: 'duplicate'; containerProvider: string; handleId: string }
  | {
      outcome: 'recorded';
      containerProvider: string;
      handleId: string;
      organizationId: string;
      workspaceId: string;
      periodStart: Date;
      billableSeconds: number;
      /** Decimal string — never a float. */
      costUsd: string;
    };

/** What one org's CI cost Motir in a period, beside what it was metered for —
 *  the margin readout, derived ENTIRELY from stored values. */
export interface OrgPeriodCostBasis {
  organizationId: string;
  periodStart: Date;
  /** Motir's side: Σ container-seconds and their cost (this meter). */
  containerSeconds: number;
  costUsd: string;
  containerCount: number;
  /** The customer's side: Σ Linux-equivalent minutes (`ciMinutesMeterService`'s
   *  rollup), which at the fleet's ×1.00 rate is also the raw billable figure. */
  linearEquivalentMinutes: number;
  /**
   * Motir's cost per metered minute — the one derived figure, and the number
   * §M's `usdPerMinute: 0.001` estimate can finally be checked against.
   *
   * NULL when the org was metered no minutes in the period: a cost with no
   * minutes under it is a real state (a container that booted for a run whose
   * `workflow_run` webhook has not landed yet, or a month of pure failed boots),
   * and dividing by zero to report it would invent a number rather than admit
   * one is not yet available.
   */
  costPerLinearEquivalentMinute: string | null;
}

export const ciFleetCostMeterService = {
  /**
   * Persist ONE container's cost record, and add it to the org's period rollup.
   *
   * Never throws for a record it simply does not meter: every "no" is a typed
   * outcome the caller logs. The caller is the teardown `finally` that
   * guarantees a container is destroyed (and the reaper), so a throw from here
   * would turn "the container is gone and we could not record it" into "the
   * container may still be running" — trading a bookkeeping gap for a billing
   * leak, which is the wrong direction every time.
   */
  async recordContainerUsage(usage: ContainerUsage): Promise<RecordContainerUsageOutcome> {
    // 1 · §8.5 — a self-hosted build runs no fleet, so there is nothing to
    // meter. Deliberately gated on `MOTIR_CLOUD` ALONE, not on
    // `isCiMeteringEnabled()`: that helper also requires a provisioning ORG
    // login, which qualifies whether GITHUB bills Motir for a repo — a question
    // this meter never asks. A container Motir booted cost Motir money whatever
    // `GITHUB_FALLBACK_ORG` says, and dropping the record because an unrelated
    // env var is unset would lose real spend.
    if (!isCloudBilling()) return { outcome: 'disabled' };

    // 2 · §4.4 — the META org is bypassed entirely, exactly as the minute meter
    // bypasses it: moooon B.V. pays its own infrastructure bill, so attributing
    // this cost would bill the house to itself. A missing org row defaults to
    // non-meta — the safe direction (it records rather than silently discards).
    const isMeta = await withOrgServiceWriteContext(usage.orgId, async (tx) => {
      const organization = await organizationRepository.findByIdInTx(usage.orgId, tx);
      return organization?.isMeta ?? false;
    });
    if (isMeta) return { outcome: 'bypassed_meta', organizationId: usage.orgId };

    // 3 · A cheap pre-check for the second teardown of the same handle. NOT the
    // correctness guard — two concurrent callers would both miss it; the
    // `(container_provider, handle_id)` unique index at step 4 is what
    // guarantees once.
    const already = await withSystemContext((tx) =>
      ciContainerUsageRepository.findByHandle(usage.provider, usage.handleId, tx),
    );
    if (already) {
      return { outcome: 'duplicate', containerProvider: usage.provider, handleId: usage.handleId };
    }

    // 4 · §4.5's period rule, applied to the container's own STOP instant: a
    // pure function of the record, so the write reads no billing state at all
    // and lands in the same monthly bucket the minute meter uses.
    const periodStart = periodStartFor(usage.stoppedAt);
    const input: CiContainerUsageCreateInput = {
      containerProvider: usage.provider,
      handleId: usage.handleId,
      containerRegion: usage.region,
      workspaceId: usage.workspaceId,
      organizationId: usage.orgId,
      projectId: usage.projectId,
      // This service meters CI RUNNERS only. Index and agent containers share
      // the fleet org but are dispatched elsewhere and record their own rows —
      // stating the workload here is what keeps the three separable (MOTIR-1995).
      workload: 'ci',
      repoFullName: usage.repoFullName,
      workflowJobId: String(usage.workflowJobId),
      cpuKind: usage.cpuKind,
      cpus: usage.cpus,
      memoryMb: usage.memoryMb,
      containerCreatedAt: usage.createdAt,
      containerStartedAt: usage.startedAt,
      containerStoppedAt: usage.stoppedAt,
      billableSeconds: usage.billableSeconds,
      periodStart,
      usdPerSecond: usage.usdPerSecond,
      costUsd: usage.costUsd,
      rateEffectiveFrom: usage.rateEffectiveFrom,
      terminalState: usage.terminalState,
      teardownReason: usage.teardownReason,
    };

    try {
      await withSystemContext(async (tx) => {
        await ciContainerUsageRepository.create(input, tx);
        await ciContainerPeriodCostRepository.incrementForPeriod(
          {
            workspaceId: usage.workspaceId,
            organizationId: usage.orgId,
            periodStart,
            billableSeconds: usage.billableSeconds,
            costUsd: usage.costUsd,
          },
          tx,
        );
      });
    } catch (err) {
      // The idempotency guarantee. A second teardown of the same handle — the
      // `finally` and the reaper both reaching it — loses the race on the unique
      // index; because the rollup increment shares this transaction, it rolls
      // back WITH the failed insert, so a duplicate can never inflate the
      // period's cost. Caught OUTSIDE the transaction on purpose: a failed
      // statement aborts the Postgres transaction, so catching it inside and
      // continuing would only produce a second, more confusing error (25P02).
      if (isUniqueViolation(err)) {
        return {
          outcome: 'duplicate',
          containerProvider: usage.provider,
          handleId: usage.handleId,
        };
      }
      throw err;
    }

    return {
      outcome: 'recorded',
      containerProvider: usage.provider,
      handleId: usage.handleId,
      organizationId: usage.orgId,
      workspaceId: usage.workspaceId,
      periodStart,
      billableSeconds: usage.billableSeconds,
      costUsd: usage.costUsd,
    };
  },

  /** What the fleet cost ONE org in the period containing `at` — the single
   *  indexed read, no recomputation from per-container rows and none from
   *  logs. */
  async getOrgPeriodCost(organizationId: string, at: Date): Promise<OrgPeriodContainerCost> {
    return withSystemContext((tx) =>
      ciContainerPeriodCostRepository.sumForOrgPeriod(organizationId, periodStartFor(at), tx),
    );
  },

  /**
   * THE MARGIN READOUT — this meter's cost beside the minute meter's metered
   * quantity, for the same org and the same period.
   *
   * Both halves are STORED ROLLUPS read by the same key, which is the acceptance
   * this card is built to meet: margin is a subtraction over two rows, never a
   * recomputation from logs or a scan of per-run history. It reads
   * `ciPeriodUsageRepository` directly rather than calling `ciMinutesMeterService`
   * — one read of a sibling meter's rollup table, not a dependency on its
   * behaviour, so neither meter can change the other's numbers.
   *
   * It returns quantities and ONE ratio, and deliberately no verdict: what a
   * minute is SOLD for lives in the entitlement + credit layer (§2, §7), and
   * pulling a price in here would couple the COGS meter to billing — the exact
   * coupling the module header refuses.
   */
  async getOrgPeriodCostBasis(organizationId: string, at: Date): Promise<OrgPeriodCostBasis> {
    const periodStart = periodStartFor(at);
    const { cost, consumption } = await withSystemContext(async (tx) => ({
      cost: await ciContainerPeriodCostRepository.sumForOrgPeriod(organizationId, periodStart, tx),
      consumption: await ciPeriodUsageRepository.sumForOrgPeriod(organizationId, periodStart, tx),
    }));

    const minutes = consumption.linearEquivalentMinutes;
    const costPerLinearEquivalentMinute =
      minutes > 0 ? new Prisma.Decimal(cost.costUsd).div(minutes).toFixed(12) : null;

    return {
      organizationId,
      periodStart,
      containerSeconds: cost.containerSeconds,
      costUsd: cost.costUsd,
      containerCount: cost.containerCount,
      linearEquivalentMinutes: minutes,
      costPerLinearEquivalentMinute,
    };
  },
};

/** A Postgres unique-constraint violation, surfaced by Prisma as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
