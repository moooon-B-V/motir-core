import { randomUUID } from 'node:crypto';
import type { FleetInFlightSlot, Prisma } from '@prisma/client';

// Data access for the FLEET IN-FLIGHT SLOTS (Story MOTIR-1916 · MOTIR-1997) —
// one row per container held by a workload that does not own a table of its own.
// Single-op methods only (CLAUDE.md 4-layer); every write requires a `tx`, and
// the count that guards a write takes one too.
//
// The decision these rows serve lives in `fleetCeilingService`; the registry
// that says WHICH workloads count from here lives in `lib/ciFleet/workloads.ts`.
// Nothing in this file knows what a ceiling is.

export interface FleetInFlightSlotTakeInput {
  /** A `FleetWorkloadKind`. Typed as the string the column holds, because a
   *  repository does not import the policy layer that names them. */
  workload: string;
  /** The workload's own id for the thing holding the container. */
  ref: string;
  organizationId?: string | null;
  workspaceId?: string | null;
  /** When this slot stops being counted if it is never released. NOT the
   *  release mechanism — see the model comment. */
  expiresAt: Date;
}

export const fleetInFlightSlotRepository = {
  /**
   * Take one slot, idempotently.
   *
   * `ON CONFLICT (workload, ref) DO NOTHING` rather than a plain insert, because
   * every caller of this is a retryable background dispatch: a redelivered index
   * job or a re-run agent step must not occupy two slots for one container. The
   * return value distinguishes the two outcomes — `true` means THIS call took
   * the slot, `false` means it was already held — and the caller needs that
   * difference, since only the taker owes a release.
   *
   * `DO NOTHING` and not `DO UPDATE`: refreshing `expires_at` on a redelivery
   * would let a caller extend a slot's safety net indefinitely by retrying,
   * turning the leak bound back into no bound at all.
   *
   * Two things raw SQL bypasses and this supplies explicitly (the pair
   * `ciPeriodChargeRepository.ensureRow` documents): `@updatedAt` (hence the
   * `NOW()`) and the id default (hence `randomUUID()`, an opaque id for a row
   * nothing joins to by id).
   */
  async take(data: FleetInFlightSlotTakeInput, tx: Prisma.TransactionClient): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO "fleet_in_flight_slot"
        ("id", "workload", "ref", "organization_id", "workspace_id",
         "claimed_at", "expires_at", "created_at", "updated_at")
      VALUES (
        ${randomUUID()},
        ${data.workload},
        ${data.ref},
        ${data.organizationId ?? null},
        ${data.workspaceId ?? null},
        NOW(), ${data.expiresAt}, NOW(), NOW()
      )
      ON CONFLICT ("workload", "ref") DO NOTHING
    `;
    return inserted === 1;
  },

  /**
   * Give a slot back — the release half, and the one that actually frees
   * capacity for every workload (`expires_at` is only the backstop for when this
   * never runs).
   *
   * A DELETE rather than a status flip: the row's whole meaning is "a container
   * exists right now", so the honest representation of "it does not" is its
   * absence. Nothing reports over this table — MOTIR-1924 and MOTIR-1995 own the
   * durable cost record — so there is no history to preserve here, and keeping
   * settled rows would put a growing `WHERE` on the most contended read in the
   * fleet.
   *
   * Returns whether a row was removed, so a double-release is visible to the
   * caller rather than silent.
   */
  async release(workload: string, ref: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.fleetInFlightSlot.deleteMany({ where: { workload, ref } });
    return result.count === 1;
  },

  /**
   * How many slots one workload is holding RIGHT NOW — the ceiling's read for
   * every workload that counts from this table.
   *
   * ⚠️ Read UNDER THE `fleet` ADMISSION LOCK and inside the same transaction as
   * the claim it guards, never on its own: it is the read half of a read-derived
   * write, and a count taken outside the lock is a snapshot two racers can both
   * act on (`notes.html` #35; the CLAUDE.md lock-before-read-derived-update
   * contract). See `ciFleetAdmissionLockRepository.lockScope`.
   *
   * ⚠️ `now` IS A PARAMETER, NOT `NOW()`. The comparison is against a Date bound
   * from the caller so the count agrees with the caller's clock — a `$queryRaw`
   * comparing a Prisma timestamp to SQL `NOW()` reads the DATABASE's clock,
   * which skews against the service's and is unpinnable under fake timers, so a
   * test asserting expiry would be asserting the wrong instant.
   */
  async countLiveForWorkload(
    workload: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.fleetInFlightSlot.count({
      where: { workload, expiresAt: { gt: now } },
    });
  },

  /** One slot by its workload-owned key — the read that answers "is this run
   *  still holding capacity?" without counting the whole fleet. */
  async findByRef(
    workload: string,
    ref: string,
    tx: Prisma.TransactionClient,
  ): Promise<FleetInFlightSlot | null> {
    return tx.fleetInFlightSlot.findUnique({ where: { workload_ref: { workload, ref } } });
  },

  /**
   * Drop every slot whose safety net has expired — housekeeping, not the release
   * path.
   *
   * The count already ignores these rows, so this changes no decision; it exists
   * so the table does not accumulate the debris of crashed dispatchers, and so
   * an operator reading it sees the live fleet rather than a graveyard.
   */
  async deleteExpired(now: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.fleetInFlightSlot.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return result.count;
  },
};
