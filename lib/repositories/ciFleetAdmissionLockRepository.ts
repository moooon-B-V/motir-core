import type { Prisma } from '@prisma/client';

// Data access for the PROVISIONING GATE's serialization anchors (Story
// MOTIR-1916 · MOTIR-1922). Two single-op methods, no logic — the decision they
// protect lives in `ciRunnerAdmissionService`.
//
// The pair is `ensureScope` + `lockScope`, and it is deliberately the same shape
// `ciPeriodChargeRepository.ensureRow` + `lockForUpdate` uses, for the same
// reason: a `SELECT … FOR UPDATE` can only lock a row that already exists, and
// the FIRST admission for a scope finds none — which is precisely when two
// racers would both sail through.

/** The one global scope. Every admission locks it, so it serializes the gate. */
export const FLEET_ADMISSION_SCOPE = 'fleet';

/** The per-project scope's name. A prefixed key rather than a second table:
 *  the two scopes are locked by the same code in the same order and differ only
 *  in what they bound. */
export function projectAdmissionScope(projectId: string): string {
  return `project:${projectId}`;
}

export const ciFleetAdmissionLockRepository = {
  /**
   * Materialize a scope's anchor row if it is not there yet, without disturbing
   * it if it is.
   *
   * `ON CONFLICT DO NOTHING` makes the insert race harmless: the loser simply
   * finds the winner's row, and the `FOR UPDATE` that follows has something to
   * take. `DO NOTHING` rather than `DO UPDATE` because this must be INERT for an
   * existing row — an upsert that touched `updated_at` would turn every
   * admission into a write on a row every other admission is queued behind.
   *
   * Two things raw SQL bypasses and this supplies explicitly (the pair
   * `ciPeriodChargeRepository.ensureRow` documents): `@updatedAt` (hence the
   * `NOW()`) and the id default — here the id IS the scope, so there is nothing
   * to generate.
   */
  async ensureScope(scope: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "ci_fleet_admission_lock" ("scope", "created_at", "updated_at")
      VALUES (${scope}, NOW(), NOW())
      ON CONFLICT ("scope") DO NOTHING
    `;
  },

  /**
   * Take the scope's row lock `FOR UPDATE`, inside the caller's transaction.
   *
   * ⚠️ THIS IS THE WHOLE CONCURRENCY GUARANTEE OF THE ADMISSION GATE. Everything
   * the gate reads afterwards — the per-project in-flight count, the fleet-wide
   * one — is a read-derived decision, and without this the two counts are
   * snapshots that two racers can both act on (`notes.html` #35; the CLAUDE.md
   * lock-before-read-derived-update contract). Mutation-check it: delete the
   * lock and the real-concurrency test must go red.
   *
   * Returns whether a row was locked. `false` means `ensureScope` was not called
   * first, which is a programming error rather than a runtime condition — the
   * caller treats it as a fail-CLOSED refusal rather than assuming a free slot.
   *
   * `tx` is REQUIRED because a row lock only lives for its transaction.
   */
  async lockScope(scope: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ scope: string }>>`
      SELECT "scope" FROM "ci_fleet_admission_lock" WHERE "scope" = ${scope} FOR UPDATE
    `;
    return rows.length > 0;
  },
};
