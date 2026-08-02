import type { Prisma } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { fleetInFlightSlotRepository as slots } from '@/lib/repositories/fleetInFlightSlotRepository';
import {
  ciFleetAdmissionLockRepository as locks,
  FLEET_ADMISSION_SCOPE,
} from '@/lib/repositories/ciFleetAdmissionLockRepository';
import {
  FLEET_WORKLOADS,
  FLEET_WORKLOAD_KINDS,
  type FleetWorkloadKind,
} from '@/lib/ciFleet/workloads';
import { fleetInFlightCeiling, fleetSlotTtlSeconds } from '@/lib/ciFleet/limits';

// THE CROSS-WORKLOAD FLEET CEILING (Story MOTIR-1916 · MOTIR-1997) — ONE
// in-flight bound over every container the fleet runs, whatever its workload,
// and the only thing that bounds Motir's fleet invoice.
//
// ⚠️ WHY IT IS NOT MOTIR-1922's CEILING ANY MORE. That guard counted
// `ci_runner_provisioning_intent`, and its comment was accurate — *"bounds
// Motir's total CI spend"*. It is not wrong; it stopped being SUFFICIENT the
// moment MOTIR-1981 put code-graph INDEX containers in the same Fly org, and
// Epic 9 will add AGENT containers. Neither writes a runner intent, so neither
// was visible to the number that is supposed to bound the invoice.
//
// **Two independent ceilings do not compose into a bound.** With MOTIR-1922's
// runner ceiling and MOTIR-1990's index cap, real peak concurrency is
// `runners + index (+ agents)` and no single number expresses it. Measured, not
// theorised: on 2026-08-02 `system.code-graph-index` and
// `system.code-graph-refresh` each carried `concurrency: 2` against one
// motir-ai, so the effective limit was 4 and neither cap meant what it said.
//
// ── THE LAYERING ────────────────────────────────────────────────────────────
// The per-workload caps sit UNDERNEATH this one and keep their own semantics:
//
//   * MOTIR-1922's per-project cap  — CI fairness.
//   * MOTIR-1990's index caps       — index fairness and throughput.
//   * Epic 9's agent cap            — seats.
//   * THIS ceiling                  — the invoice.
//
// One number that means what it says; several fairness caps below it that do
// not. This replaces none of them.
//
// ── WHY IT SHARES MOTIR-1922's LOCK ─────────────────────────────────────────
// A ceiling over N workloads is exact only if every workload's admission
// contends on the SAME row. `FLEET_ADMISSION_SCOPE` is that row, and it is
// already the one every CI admission takes, so a second anchor would be two
// locks over one invariant — which is not a lock. Everything read under it is a
// read-derived write (`notes.html` #35; the CLAUDE.md
// lock-before-read-derived-update contract). MUTATION-CHECK IT: delete the
// `lockScope` call below and `tests/ciFleet/fleetCeiling.test.ts`'s
// mixed-workload race must go red.
//
// ── FAIL CLOSED ─────────────────────────────────────────────────────────────
// If the count cannot be established, DO NOT BOOT. This matches MOTIR-1922's
// deliberate asymmetry from the other side: the credit read fails OPEN because a
// Motir outage must never read to a user as "you are out of credits"; this fails
// CLOSED because the other side is unbounded spend on an account with no
// provider ceiling at all (`docs/decisions/ci-runner-fleet.md` §9 — Fly offers
// neither a spending cap nor a billing alert). A queued container is
// recoverable; a runaway invoice is not.
//
// ── NO BYPASS ───────────────────────────────────────────────────────────────
// `isMeta` does NOT lift it, and neither does self-hosting. MOTIR-1922 already
// said it for CI — *"it bounds Motir's own invoice, and a meta-org runaway costs
// exactly as much as any other"* — and MOTIR-1981 decision 7 puts meta's INDEX
// containers on this same fleet, so it now matters more, not less. There is
// deliberately no tenant-shaped argument to any function here.

/** What the ceiling saw, per workload and in total. Carried out of every
 *  decision so an operator's log names WHICH workload filled the fleet — a bare
 *  "24/24" cannot be acted on. */
export interface FleetInFlightCensus {
  total: number;
  byWorkload: Record<FleetWorkloadKind, number>;
}

export type FleetSlotVerdict =
  /** Reserved — the slot is taken and this caller owes the release. */
  | { outcome: 'reserved'; census: FleetInFlightCensus; ceiling: number }
  /** This `(workload, ref)` already held a slot. Not an error: the take is
   *  idempotent, so a redelivery lands here rather than double-occupying. */
  | { outcome: 'already_held' }
  /** Not reserved. Nothing was written; the caller queues and retries. */
  | { outcome: 'deferred'; reason: 'fleet_ceiling' | 'gate_unavailable'; detail: string };

export interface FleetSlotRequest {
  workload: FleetWorkloadKind;
  /** The workload's own id for the thing about to hold a container. */
  ref: string;
  /** Attribution only — never a tenancy boundary, and never a bypass. */
  organizationId?: string | null;
  workspaceId?: string | null;
  /**
   * The container's own hard-kill budget. Becomes the slot's `expires_at`
   * safety net, so a release that never runs costs capacity for this long
   * instead of forever. Defaults to the configured fleet-wide TTL.
   *
   * ⚠️ A value SHORTER than the container's real life would under-count and let
   * the ceiling be exceeded — pass the workload's real timeout, not a guess.
   */
  ttlSeconds?: number;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/** "CI runners 12, code-graph index 8, hosted agents 4" — the breakdown an
 *  operator needs to know which workload to lean on. Exported because
 *  MOTIR-1922's gate reports the same refusal from its own transaction, and two
 *  spellings of one ceiling's log would be two ceilings as far as a reader is
 *  concerned. */
export function describeFleetCensus(census: FleetInFlightCensus): string {
  return FLEET_WORKLOAD_KINDS.map(
    (kind) => `${FLEET_WORKLOADS[kind].label} ${census.byWorkload[kind]}`,
  ).join(', ');
}

export const fleetCeilingService = {
  /**
   * How many containers the WHOLE FLEET is holding, across every registered
   * workload.
   *
   * ⚠️ THE CALLER MUST ALREADY HOLD `FLEET_ADMISSION_SCOPE` IN `tx`. This is the
   * read half of a read-derived write; taken outside the lock it is a snapshot
   * two racers can both act on. It is exposed rather than inlined because
   * MOTIR-1922's gate calls it from INSIDE its own locked transaction — it has
   * already taken the lock and is mid-claim, so re-entering through `reserve`
   * would deadlock the gate against itself.
   *
   * Counted SEQUENTIALLY, not with `Promise.all`: the counts share one
   * interactive transaction, and Prisma serialises concurrent queries on a
   * single `tx` anyway — parallelising would buy nothing and make an
   * intermittent "Transaction already closed" the reward for reading it as
   * clever.
   *
   * Never swallows: a counter that throws must reach the caller's fail-CLOSED
   * handler rather than contribute a silent zero, which is the one arithmetic
   * that turns a full fleet into an empty one.
   */
  async census(now: Date, tx: Prisma.TransactionClient): Promise<FleetInFlightCensus> {
    const byWorkload = {} as Record<FleetWorkloadKind, number>;
    let total = 0;
    for (const kind of FLEET_WORKLOAD_KINDS) {
      const count = await FLEET_WORKLOADS[kind].countInFlight(now, tx);
      byWorkload[kind] = count;
      total += count;
    }
    return { total, byWorkload };
  },

  /**
   * Decide whether ONE container of `workload` may boot, and TAKE its slot if
   * so — the admission path for every workload that is not CI.
   *
   * CI does not use this: MOTIR-1922's gate has three guards to decide in one
   * transaction and takes the same lock itself, so it calls {@link census}
   * in-line. Everything else — MOTIR-1990's index dispatch, Epic 9's agent
   * dispatch — gets the ceiling by calling this and nothing more, which is the
   * point: a new workload cannot be admitted without being counted.
   *
   * Deciding and taking the slot in ONE locked transaction is what makes the
   * ceiling exact, for the reason MOTIR-1922's claim documents: a gate that
   * decided and let someone else take the slot would be deciding from a count
   * that does not yet include the decisions already made.
   *
   * Never throws. Every refusal is a typed verdict, because every caller is a
   * background dispatch: a throw becomes a job retry, and retrying "the fleet is
   * full" achieves nothing that queueing does not.
   */
  async reserve(request: FleetSlotRequest, now = new Date()): Promise<FleetSlotVerdict> {
    const ceiling = fleetInFlightCeiling();
    const ttlSeconds = request.ttlSeconds ?? fleetSlotTtlSeconds();
    try {
      return await withSystemContext(async (tx) => {
        await locks.ensureScope(FLEET_ADMISSION_SCOPE, tx);
        if (!(await locks.lockScope(FLEET_ADMISSION_SCOPE, tx))) {
          throw new Error('the fleet admission lock could not be taken');
        }

        // An already-held slot is NOT a new container, so it must not be judged
        // against the ceiling — a redelivery of a job that is already running
        // would otherwise be refused capacity it is already occupying, and the
        // caller would tear down a live container to honour a refusal.
        const held = await slots.findByRef(request.workload, request.ref, tx);
        if (held) return { outcome: 'already_held' as const };

        const census = await this.census(now, tx);
        if (census.total >= ceiling) {
          return {
            outcome: 'deferred' as const,
            reason: 'fleet_ceiling' as const,
            detail: `the fleet is at its in-flight ceiling (${census.total}/${ceiling}: ${describeFleetCensus(census)})`,
          };
        }

        const took = await slots.take(
          {
            workload: request.workload,
            ref: request.ref,
            organizationId: request.organizationId ?? null,
            workspaceId: request.workspaceId ?? null,
            expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
          },
          tx,
        );
        // The insert raced another transaction that committed the same
        // (workload, ref) between the read above and here. Harmless and
        // idempotent — the slot exists exactly once either way.
        if (!took) return { outcome: 'already_held' as const };

        return { outcome: 'reserved' as const, census, ceiling };
      });
    } catch (err) {
      // FAIL CLOSED. The transaction rolled back, so no slot was taken. An
      // unestablished count is treated as a FULL fleet, never an empty one.
      console.error(
        '[fleetCeilingService] the fleet ceiling could not be evaluated — not booting',
        {
          workload: request.workload,
          ref: request.ref,
          detail: detailOf(err),
        },
      );
      return {
        outcome: 'deferred',
        reason: 'gate_unavailable',
        detail: `the cross-workload in-flight count could not be established: ${detailOf(err)}`,
      };
    }
  },

  /**
   * Give a slot back — call this when the container ends, however it ended.
   *
   * This is what makes "completion of any workload's container frees a slot"
   * true for the slot-backed workloads; CI gets the same property for free, from
   * its own settle path. Releasing does NOT take the fleet lock: a delete is not
   * read-derived, and queueing every teardown behind the admission lock would
   * make the fleet slowest to free capacity exactly when it is fullest.
   *
   * Best-effort, and deliberately so: the worst case of a failure here is a slot
   * that occupies capacity until `expires_at` ages it out — visible and bounded
   * — whereas a throw would fail a teardown path over a bookkeeping row.
   */
  async release(workload: FleetWorkloadKind, ref: string): Promise<boolean> {
    try {
      return await withSystemContext((tx) => slots.release(workload, ref, tx));
    } catch (err) {
      console.error('[fleetCeilingService] could not release a fleet slot', {
        workload,
        ref,
        detail: detailOf(err),
      });
      return false;
    }
  },

  /** Drop slots whose safety net has expired. Housekeeping only — the count
   *  already ignores them, so this changes no decision; it keeps the table
   *  readable as "the live fleet" for whoever opens it during an incident. */
  async sweepExpired(now = new Date()): Promise<number> {
    return withSystemContext((tx) => slots.deleteExpired(now, tx));
  },
};
