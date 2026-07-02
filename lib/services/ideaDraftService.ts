import { db } from '@/lib/db';
import { ideaDraftRepository } from '@/lib/repositories/ideaDraftRepository';
import { normalizePendingIdea } from '@/lib/onboarding/pendingIdea';
import { DraftNotFoundError, EmptyIdeaError } from '@/lib/ideaDraft/errors';
import type { CreateIdeaDraftResultDTO, ClaimIdeaDraftResultDTO } from '@/lib/dto/ideaDraft';

// Business logic for the cross-origin idea-draft handoff (Subtask 7.22.2 /
// MOTIR-1458). Owns the two transactions (create, single-use claim) and all
// validation. The normalization (trim + clamp to MAX_PENDING_IDEA_LENGTH) is the
// SAME contract the `motir_pending_idea` cookie enforces — reused from
// `lib/onboarding/pendingIdea.ts` so the stored draft and the seeded cookie can
// never disagree on the bound. Anti-abuse note: rate-limiting is applied at the
// route boundary (it needs the request IP); the size cap + TTL live here.

// The draft only has to survive the hop from the marketing click to the claim on
// `/sign-in` (a few seconds); 30 minutes is generous headroom and matches the
// cookie's own TTL so the two windows are consistent.
const IDEA_DRAFT_TTL_MS = 30 * 60 * 1000;

export const ideaDraftService = {
  /**
   * Store an anonymous idea draft and return its opaque id (the `draftId`). The
   * raw text is trimmed + clamped to the shared bound; a whitespace-only idea is
   * rejected (nothing worth preserving). One transaction.
   */
  async createDraft(rawIdea: unknown): Promise<CreateIdeaDraftResultDTO> {
    const idea = normalizePendingIdea(rawIdea);
    if (!idea) throw new EmptyIdeaError();

    const now = new Date();
    const draft = await db.$transaction(async (tx) => {
      return ideaDraftRepository.create(
        { idea, expiresAt: new Date(now.getTime() + IDEA_DRAFT_TTL_MS) },
        tx,
      );
    });
    return { draftId: draft.id };
  },

  /**
   * Claim a draft by its opaque id: read the preserved idea, then delete the row
   * (single-use). A missing, already-claimed, or expired id throws
   * `DraftNotFoundError` — the caller degrades to a normal login. The row is
   * deleted whether or not it was still valid in time, so an expired id leaves no
   * residue and cannot be probed. One transaction.
   */
  async claimDraft(draftId: string): Promise<ClaimIdeaDraftResultDTO> {
    const now = new Date();
    // Resolve + delete INSIDE the transaction, but signal the outcome by RETURN
    // (never throw here): throwing rolls the transaction back, which would undo
    // the delete of an expired row. We throw AFTER the tx commits so the consume
    // / sweep persists whether or not the draft was still valid.
    const idea = await db.$transaction(async (tx) => {
      const draft = await ideaDraftRepository.findById(draftId, tx);
      if (!draft) return null;
      // Single-use + no stale rows: delete on any resolution (valid or expired).
      await ideaDraftRepository.deleteById(draftId, tx);
      return draft.expiresAt.getTime() <= now.getTime() ? null : draft.idea;
    });
    if (idea === null) throw new DraftNotFoundError();
    return { idea };
  },
};
