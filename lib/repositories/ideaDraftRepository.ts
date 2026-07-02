import { Prisma, type IdeaDraft } from '@prisma/client';
import { db } from '@/lib/db';

// Idea-draft repository (Subtask 7.22.2 / MOTIR-1458) — single Prisma operations
// on the anonymous, short-lived `idea_draft` table. Per CLAUDE.md: write methods
// require `tx: Prisma.TransactionClient`; the read that guards the single-use
// delete runs inside the claim transaction, so it takes `tx` too. No business
// logic, no transactions here — `ideaDraftService` owns those.

export const ideaDraftRepository = {
  /** Insert an anonymous draft. `id` is auto-assigned (cuid) and IS the draftId. */
  async create(
    data: { idea: string; expiresAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<IdeaDraft> {
    return tx.ideaDraft.create({ data });
  },

  /**
   * Resolve a draft by its opaque id. Read inside the claim transaction (it gates
   * the subsequent single-use delete), so it takes `tx`. TTL is NOT filtered here
   * — the service compares `expiresAt` against a bound `now` so an expired row is
   * treated as absent (and still deleted, to avoid leaving stale rows behind).
   */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<IdeaDraft | null> {
    return tx.ideaDraft.findUnique({ where: { id } });
  },

  /** Single-use delete of a claimed (or expired) draft. Returns rows removed (0 or 1). */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.ideaDraft.deleteMany({ where: { id } });
    return r.count;
  },

  /**
   * Sweep every draft already past its TTL — best-effort GC so abandoned drafts
   * (created, never claimed) don't accumulate. Bound `now` is passed as a JS Date
   * (never SQL `NOW()`) to avoid app/DB clock skew. Returns rows removed.
   */
  async deleteExpired(now: Date, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.ideaDraft.deleteMany({ where: { expiresAt: { lt: now } } });
    return r.count;
  },

  /** Test-only direct read by id (asserts single-use deletion / TTL cleanup). */
  async findByIdUnsafe(id: string): Promise<IdeaDraft | null> {
    return db.ideaDraft.findUnique({ where: { id } });
  },
};
