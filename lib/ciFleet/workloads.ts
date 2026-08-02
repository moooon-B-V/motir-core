import type { Prisma } from '@prisma/client';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';

// THE FLEET WORKLOAD REGISTRY (Story MOTIR-1916 · MOTIR-1997) — the list of
// everything that can be running a container on Motir's fleet, and where each
// one's in-flight count comes from.
//
// This is the policy half of the CROSS-WORKLOAD ceiling, the way `limits.ts` is
// the policy half of the caps: it binds counters, it does not decide anything.
// The locking, the summing and the verdict live in `fleetCeilingService`.
//
// ⚠️ WHY A REGISTRY AT ALL. MOTIR-1922's ceiling counted
// `ci_runner_provisioning_intent` and nothing else, and its comment was accurate
// — *"bounds Motir's total CI spend"*. MOTIR-1981 decisions 2–3 put CODE-GRAPH
// INDEX containers in the same Fly org and Epic 9 adds HOSTED AGENT containers;
// neither writes a runner intent. Two independent per-workload caps do not
// compose into a bound: real peak concurrency is `runners + index + agents`, and
// no per-workload number expresses it. `docs/decisions/ci-runner-fleet.md` §9
// records that Fly offers NEITHER a spending cap NOR a billing alert, so nothing
// sits underneath this number.
//
// It was measured, not theorised: on 2026-08-02 `system.code-graph-index` and
// `system.code-graph-refresh` each carried `concurrency: 2` against one
// motir-ai, so the effective limit was 4 and neither cap meant what it said.
//
// ⚠️ THE TOTALITY GUARD IS THE `Record<FleetWorkloadKind, …>` BELOW. Adding a
// member to the union without giving it a counter is a COMPILE error, not a
// silently-uncounted workload — which is the whole failure mode this card
// exists to close. Do not weaken it to a `Partial`, a lookup with a fallback, or
// an array.

/**
 * Every kind of container the fleet can be running.
 *
 * All three are declared NOW, before two of them ship, and that is deliberate:
 * the seam has to exist before the workload does, or the workload lands and the
 * ceiling silently does not see it — exactly how the runner-only ceiling stopped
 * being a bound.
 */
export type FleetWorkloadKind =
  /** MOTIR-1921/1922: one ephemeral GitHub Actions runner per queued job. */
  | 'ci_runner'
  /** MOTIR-1981/1990: one container per code-graph index run. */
  | 'code_graph_index'
  /** Epic 9: one container per hosted agent run. */
  | 'hosted_agent';

export interface FleetWorkload {
  readonly kind: FleetWorkloadKind;
  /** How an operator reads this workload in a ceiling breakdown. */
  readonly label: string;
  /**
   * How many containers this workload is holding right now.
   *
   * ⚠️ MUST be read under the `fleet` admission lock, inside the caller's
   * transaction. Every implementation here is a repository single-op that takes
   * a `tx` for exactly that reason.
   */
  countInFlight(now: Date, tx: Prisma.TransactionClient): Promise<number>;
}

/**
 * Count from the SHARED SLOT TABLE — the counter for a workload that does not
 * own a table of its own yet.
 *
 * A workload that later grows one (its own runs table with a status column)
 * swaps its registry entry to count that instead, and the ceiling stays correct
 * with no change here and none in the service.
 */
function slotBackedWorkload(kind: FleetWorkloadKind, label: string): FleetWorkload {
  return {
    kind,
    label,
    countInFlight: (now, tx) => fleetInFlightSlotRepository.countLiveForWorkload(kind, now, tx),
  };
}

/**
 * THE REGISTRY. Exhaustive by construction (see the totality guard above).
 *
 * ⚠️ CI COUNTS ITS OWN TABLE AND DOES NOT WRITE A SLOT. `ci_runner_provisioning_
 * intent.status` already IS the CI in-flight window (`provisioning` + `running`),
 * maintained by every claim, release and settle path that exists — so completion
 * frees a fleet slot with no extra bookkeeping, exactly as MOTIR-1922 documented
 * for its own count. Mirroring it into `fleet_in_flight_slot` would add a dual
 * write on the hottest path in the fleet and invent a leak class where none
 * exists. The union is what makes both representations legal at once.
 */
export const FLEET_WORKLOADS: Record<FleetWorkloadKind, FleetWorkload> = {
  ci_runner: {
    kind: 'ci_runner',
    label: 'CI runners',
    countInFlight: (_now, tx) => ciRunnerProvisioningIntentRepository.countInFlightFleetWide(tx),
  },
  code_graph_index: slotBackedWorkload('code_graph_index', 'code-graph index'),
  hosted_agent: slotBackedWorkload('hosted_agent', 'hosted agents'),
};

/** Every registered kind, in a stable order — the iteration order of the
 *  registry, so a new workload appears in every breakdown without a second edit. */
export const FLEET_WORKLOAD_KINDS = Object.keys(FLEET_WORKLOADS) as FleetWorkloadKind[];

/** The workloads that register their containers in `fleet_in_flight_slot`
 *  rather than counting a table of their own. Exported so the seam is
 *  discoverable — and assertable — rather than inferred from the bindings. */
export const SLOT_BACKED_WORKLOADS: FleetWorkloadKind[] = FLEET_WORKLOAD_KINDS.filter(
  (kind) => kind !== 'ci_runner',
);
