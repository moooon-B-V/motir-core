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
// not have. **Amendment 2 does not open one**: releasing a SUBDOMAIN removes the
// ADDRESS rows and WRITES a reservation for each — it never removes a
// reservation, which is exactly why the release keeps §8's protection intact.
//
// ⚠️ AND `retired_from_workspace_id` NO LONGER NAMES ONLY A DELETED WORKSPACE
// (Amendment 2, MOTIR-4454). The schema's own comment on that column and this
// table's RLS migration were both written for Amendment 1, where the only writer
// was `workspacesService.deleteWorkspace` and the workspace was on its way out —
// so both describe the value as naming a workspace that no longer exists. A
// release writes it while the workspace is alive. Nothing about the column's
// shape or its policies changes: it is still not a relation, the
// `FOR SELECT USING (true)` arm is still what makes a GLOBAL namespace
// answerable, and the insert arm's
// `retired_from_workspace_id = current_setting('app.workspace_id')` is satisfied
// by construction, because a release runs inside `withWorkspaceContext` bound to
// the workspace it is releasing. **The migration's comment is left alone on
// purpose** — an applied migration is checksummed, so editing one is drift; the
// correction lives here and on the schema field.

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
   * How many hostnames a workspace has RETIRED into the reservation table — the
   * second half of ADR §8's rename-cap input (Amendment 2, MOTIR-4454).
   *
   * The cap used to read `countAliasesForWorkspace` alone, which is a count of
   * live alias ROWS. A release deletes those rows, so a cap that reads only them
   * is handed back in full on every release and
   * `claim → rename ×5 → release`, repeated, burns names out of a shared
   * namespace without bound. Amendment 2 therefore measures the cap over names
   * BURNT — aliases held PLUS hostnames this workspace has reserved — and this
   * is that second term. For a workspace that has never released it is `0`, so
   * the generalisation returns exactly the old number.
   *
   * ⚠️ `retired_from_workspace_id` is NOT only a deleted workspace's id any
   * more. Amendment 1 wrote it from `workspacesService.deleteWorkspace`, where
   * the workspace was on its way out; a release writes it while the workspace is
   * alive, which is what makes this count answerable at all.
   */
  async countForWorkspaceInTx(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.publicHostnameReservation.count({
      where: { retiredFromWorkspaceId: workspaceId },
    });
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
