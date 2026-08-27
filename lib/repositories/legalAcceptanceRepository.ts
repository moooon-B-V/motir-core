import { type Prisma, type LegalAcceptance } from '@/generated/prisma/client';

// Data access for `legal_acceptance` (Story 8.4 · Subtask MOTIR-1135) — one row
// per (user, document, version), append-only.
//
// ⚠️ BOTH METHODS TAKE `tx`, INCLUDING THE READ, and that is not the usual
// pattern. `CLAUDE.md` lets a pure read use the `db` singleton — but this table
// is RLS-gated on `app.user_id`, and that GUC is bound by `withUserContext`,
// which is a TRANSACTION. A read on the singleton runs with no GUC bound, the
// policy's predicate is NULL, and it returns ZERO ROWS while raising nothing:
// the denial reads as *"this person has agreed to nothing"*, which is the one
// wrong answer that silently holds every reader at the interstitial. Requiring
// the client makes that unrepresentable rather than merely documented.
export const legalAcceptanceRepository = {
  /**
   * Every acceptance this user holds for the named documents — the whole
   * history, not the latest per document. `outstandingReconsent` picks the
   * latest by `acceptedAt`; deciding that here would put a business rule in a
   * repository.
   */
  async findByUserAndSlugs(
    userId: string,
    documentSlugs: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<LegalAcceptance[]> {
    return tx.legalAcceptance.findMany({
      where: { userId, documentSlug: { in: [...documentSlugs] } },
      orderBy: { acceptedAt: 'asc' },
    });
  },

  /**
   * Record one acceptance act: several documents, one shared timestamp.
   *
   * ⚠️ `skipDuplicates`, so this is IDEMPOTENT on the (user, document, version)
   * key. The signup hook can retry and a double-submitted interstitial can
   * arrive twice without stamping a second, later timestamp over the moment the
   * person actually agreed — the row is evidence, and the FIRST one is the true
   * one. Returns how many rows were genuinely new, which is what lets a caller
   * tell a real acceptance from a replay.
   */
  async createMany(
    rows: readonly { userId: string; documentSlug: string; version: string; acceptedAt: Date }[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await tx.legalAcceptance.createMany({
      data: [...rows],
      skipDuplicates: true,
    });
    return result.count;
  },
};
