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
  /** WHICH RUN is taking it (MOTIR-2160) — the workload's own identifier for the
   *  dispatch, stamped so a later admission can tell this holder apart from a
   *  second run asking for the same `ref`, and so a release can be refused unless
   *  it owns the row. Omit it to keep the pre-MOTIR-2160 behaviour. */
  ownerRef?: string | null;
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
   * turning the leak bound back into no bound at all. It is also what keeps
   * `owner_ref` truthful (MOTIR-2160) — a losing insert must not restamp the row
   * with ITS run, or the holder's own settle would then fail to recognise the
   * slot it is holding.
   *
   * Two things raw SQL bypasses and this supplies explicitly (the pair
   * `ciPeriodChargeRepository.ensureRow` documents): `@updatedAt` (hence the
   * `NOW()`) and the id default (hence `randomUUID()`, an opaque id for a row
   * nothing joins to by id).
   */
  async take(data: FleetInFlightSlotTakeInput, tx: Prisma.TransactionClient): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO "fleet_in_flight_slot"
        ("id", "workload", "ref", "owner_ref", "organization_id", "workspace_id",
         "claimed_at", "expires_at", "created_at", "updated_at")
      VALUES (
        ${randomUUID()},
        ${data.workload},
        ${data.ref},
        ${data.ownerRef ?? null},
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
   * Give a slot back ONLY IF THIS RUN IS THE ONE HOLDING IT (MOTIR-2160).
   *
   * The ownership-checked half of {@link release}, and the smaller of the two
   * halves that stop two runs sharing one slot's capacity. `release` deletes by
   * `(workload, ref)` alone, which is correct for a workload whose ref already
   * names one run — and was silently wrong for the index workload, whose ref is
   * `(projectId, repoRef)`: the first run to settle deleted the row while the
   * OTHER run's container was still alive and still billing, and the census then
   * under-counted a live container. Worse, the freed row could be taken by a
   * third run and deleted in turn by the second's settle — a cascade in which no
   * slot ever names the container it stands for.
   *
   * ⚠️ THE NULL ARM IS DELIBERATE, and it is the migration window, not a loophole.
   * A row with no `owner_ref` was taken before this column existed, so no run can
   * prove it; refusing those would strand every slot in flight at deploy time for
   * its full TTL. It is safe exactly where this method is called from — after a
   * SUCCESSFUL teardown, i.e. once the caller's own container is provably gone —
   * so the only way it under-counts is a pre-MOTIR-2160 overlapping pair, which
   * is the defect this column removes and cannot arise for rows written after it.
   * A slot owned by a DIFFERENT named run is never released.
   *
   * Returns whether a row was actually removed, so a refused release is visible
   * to the caller rather than silent.
   */
  async releaseOwned(
    workload: string,
    ref: string,
    ownerRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.fleetInFlightSlot.deleteMany({
      where: { workload, ref, OR: [{ ownerRef }, { ownerRef: null }] },
    });
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

  /**
   * How many slots one workload is holding FOR ONE WORKSPACE — the per-tenant
   * fairness read (MOTIR-1990's `ceil(global / 2)` cap).
   *
   * ⚠️ The same locking contract as {@link countLiveForWorkload}: read under the
   * `fleet` admission lock, in the same transaction as the take it guards. Two
   * racers from the same workspace reading this outside the lock both see room.
   *
   * ⚠️ `workspace_id` IS ATTRIBUTION, NOT A TENANCY BOUNDARY — the model comment
   * says so, and this read does not change it. A slot with a NULL workspace is
   * counted by nobody's per-tenant cap and by everybody's global one, which is
   * the honest reading of "a container whose tenant was not recorded": it spends,
   * so it must bound the invoice, but it cannot be attributed to a tenant's
   * fairness allowance.
   *
   * No index of its own on purpose. The predicate rides the existing
   * `[workload, expiresAt]` index and then filters a set the FLEET CEILING
   * already bounds — a handful of rows by construction, never a table scan that
   * grows.
   */
  async countLiveForWorkloadInWorkspace(
    workload: string,
    workspaceId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.fleetInFlightSlot.count({
      where: { workload, workspaceId, expiresAt: { gt: now } },
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
