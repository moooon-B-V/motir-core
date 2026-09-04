import type { Prisma } from '@/generated/prisma/client';

// The §8 hostname-reservation data layer — Bug MOTIR-4366.
//
// `prisma/schema.prisma`'s `model PublicHostnameReservation` carries the shape
// and the reasoning; `lib/publicAddresses/hostnameReservation.ts` owns the
// transform. This file owns the queries and nothing else.
//
// Single Prisma operation per method, `tx` REQUIRED on every one — `CLAUDE.md`'s
// 4-layer contract. There is no `db` singleton read here on purpose: every
// caller is already inside a bound transaction (a claim, or the delete this
// table exists to survive), and a singleton read of a policy-gated table is the
// silent-zero the RLS singleton-read guard exists to refuse.
//
// ⚠️ NO REMOVE METHOD, AND THAT IS THE CONTRACT. A reservation is held for ever
// (`docs/decisions/public-tenant-addresses.md` §8); the only path that can
// release one is an operator under `app.system_admin`, which the migration's
// policy split is what enforces. A method here would be a door the product does
// not have.

export const publicHostnameReservationRepository = {
  /**
   * Is this digest reserved?
   *
   * A count rather than a row read: the caller never needs the reservation, only
   * the answer, and returning the row would hand a claim path the provenance of
   * a workspace it has no business knowing about.
   */
  async isReservedInTx(hostnameHash: string, tx: Prisma.TransactionClient): Promise<boolean> {
    return (await tx.publicHostnameReservation.count({ where: { hostnameHash } })) > 0;
  },

  /**
   * Reserve a set of digests, retiring them from one workspace.
   *
   * `skipDuplicates` makes it IDEMPOTENT, which the erasure sweep needs rather
   * than merely likes: `accountErasureSweepService` is resumable by construction
   * and re-derives everything it acts on, so a tick that fails after the delete
   * commits re-runs this write — and a digest already held (by this workspace's
   * own earlier retirement, or by a name that somehow collides) must be a no-op
   * and not a 23505 that aborts the erasure.
   */
  async reserveMany(
    rows: ReadonlyArray<{ hostnameHash: string; retiredFromWorkspaceId: string }>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await tx.publicHostnameReservation.createMany({
      data: [...rows],
      skipDuplicates: true,
    });
    return count;
  },
};
