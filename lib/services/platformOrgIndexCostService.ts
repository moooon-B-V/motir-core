import { fetchOrgIndexPools, getOrgUsage } from '@/lib/ai/motirAiClient';
import { isCloudBilling } from '@/lib/billing/availability';
import type { OrgIndexPools } from '@/lib/ciFleet/indexAllowance';
import { CONTAINER_WORKLOAD_BY_FLEET_KIND } from '@/lib/ciFleet/workloads';
import type {
  OrgIndexPoolsDTO,
  OrgIndexStateDTO,
  PlatformOrgIndexCostDTO,
  WorkloadCostLineDTO,
} from '@/lib/dto/platformOrgIndexCost';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { ciFleetCostMeterService } from '@/lib/services/ciFleetCostMeterService';
import { platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE ORG PAGE'S INDEX & FLEET COST CARD (MOTIR-5341 · Story MOTIR-4335; design
// Panel 14 and its Panel 14b states).
//
// ⚠️⚠️ MOTIR DOES NOT CHARGE FOR CODE INDEXING. This is Motir's internal accounting,
// read by platform staff; nothing it returns reaches a customer.
//
// ⚠️ BOTH POOLS, NEVER CONFLATED. The credit balance is the pool the customer sees;
// the index allowance is internal. They arrive from motir-ai as separate objects and
// leave this service as separate objects.
//
// ⚠️ EVERY READ THAT FAILED IS UNKNOWN, AND EVERY LINE THAT DID NOT RUN IS ABSENT —
// never a zero. A panel rendering a missing read as `$0` tells an operator the org is
// free when it may be the most expensive one they have.

const KNOWN_STATES: readonly OrgIndexStateDTO[] = [
  'under',
  'over_still_indexing',
  'stopped_no_credit',
  'stopped_allowance_exhausted',
  'exempt',
  'not_configured',
  'not_granted_yet',
];

const pct = (consumed: number, granted: number): number | null =>
  granted > 0 ? (consumed / granted) * 100 : null;

function poolsDto(pools: OrgIndexPools | null, tokenSpend: number | null): OrgIndexPoolsDTO {
  if (pools === null) return { state: 'unknown' };
  if (!pools.known) return { state: 'absent' };
  const granted = pools.tier?.allotmentCredits ?? null;
  return {
    state: 'read',
    tierName: pools.tier?.name ?? null,
    credit: {
      remaining: pools.credit.balanceCredits,
      granted,
      consumed: tokenSpend,
      pct: granted !== null && tokenSpend !== null ? pct(tokenSpend, granted) : null,
    },
    index: pools.index
      ? {
          window: pools.index.window,
          remaining: pools.index.remainingCredits,
          granted: pools.index.grantedCredits,
          consumed: pools.index.consumedCredits,
          pct: pct(pools.index.consumedCredits, pools.index.grantedCredits),
        }
      : null,
    indexState: (KNOWN_STATES as readonly string[]).includes(pools.state)
      ? (pools.state as OrgIndexStateDTO)
      : 'other',
  };
}

export const platformOrgIndexCostService = {
  /**
   * The card, for one organisation, for one platform principal. Re-asserts the staff
   * ladder and records the cross-tenant read against the organisation.
   */
  async read(
    principal: PlatformPrincipal,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<PlatformOrgIndexCostDTO> {
    await requirePlatformStaff('support');
    await platformAuditService.record(principal, {
      action: 'estate.read',
      targetKind: 'organization',
      targetId: organizationId,
    });

    // Off-cloud there is no fleet and no allowance: the card says so and reads nothing.
    if (!isCloudBilling()) return { meter: 'disabled' };

    const [pools, usage, lines, pause] = await Promise.all([
      fetchOrgIndexPools(organizationId),
      getOrgUsage({ coreOrganizationId: organizationId, scope: 'org' }).catch(() => null),
      ciFleetCostMeterService.getOrgPeriodCostByWorkload(organizationId, now),
      withSystemContext((tx) =>
        githubRepoRepository.findLatestIndexPauseForOrganization(organizationId, tx),
      ),
    ]);
    const tokenSpendCredits = usage?.monthSpend ?? null;

    // Every cost line the meter can record, in its own order, with the ones that did
    // not run drawn ABSENT rather than omitted or zeroed.
    const byWorkload = new Map(lines.map((line) => [line.workload, line]));
    const workloads: WorkloadCostLineDTO[] = [
      ...new Set(Object.values(CONTAINER_WORKLOAD_BY_FLEET_KIND)),
    ].map((workload) => {
      const line = byWorkload.get(workload);
      return line
        ? {
            workload,
            containerCount: line.containerCount,
            containerSeconds: line.containerSeconds,
            costUsd: line.costUsd,
          }
        : { workload, containerCount: null, containerSeconds: null, costUsd: null };
    });

    return {
      meter: 'enabled',
      pools: poolsDto(pools, tokenSpendCredits),
      tokenSpendCredits,
      workloads,
      pause:
        pause?.indexPausedReason && pause.indexPausedAt
          ? {
              reason: pause.indexPausedReason.replace(/^paused_index_/, ''),
              since: pause.indexPausedAt.toISOString(),
            }
          : null,
    };
  },
};
