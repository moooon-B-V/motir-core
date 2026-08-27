import { withUserContext } from '@/lib/workspaces/context';
import { legalAcceptanceRepository } from '@/lib/repositories/legalAcceptanceRepository';
import { listLegalDocuments, type LegalDocument } from '@/lib/legal/documents';
import {
  RECONSENT_DOCUMENT_SLUGS,
  outstandingReconsent,
  type OutstandingDocument,
} from '@/lib/legal/consent';

// RECORDING WHAT A PERSON AGREED TO, AND ASKING AGAIN WHEN IT MATERIALLY CHANGES
// (Story 8.4 · Subtask MOTIR-1135).
//
// Two acts, one table:
//
//   * `recordAcceptance` — at sign-up (the Better-Auth `user.create.after` hook)
//     and at the re-consent interstitial's "Agree and continue".
//   * `resolveOutstanding` — the gate's read, on every signed-in page load.
//
// The materiality rule and the three-document set live in `lib/legal/consent.ts`
// and are PURE; this file is the orchestration and the transaction around them.

/**
 * The versions currently published, for the three documents re-consent covers.
 *
 * ⚠️ READ FROM DISK AT THE MOMENT OF THE CALL, deliberately — no module-level
 * cache. `listLegalDocuments` is a `readdirSync` + up to seven small
 * `readFileSync`s out of the deployed bundle, which is cheap next to the
 * database round trip it shares a transaction with; and the alternative is a
 * cache that serves the PREVIOUS version of the Terms for the lifetime of a
 * server process after a deploy. On a screen whose entire job is to be current
 * about what a person is agreeing to, stale is the failure that matters.
 */
function reconsentDocuments(): LegalDocument[] {
  return listLegalDocuments().filter((document) =>
    (RECONSENT_DOCUMENT_SLUGS as readonly string[]).includes(document.slug),
  );
}

export const legalAcceptanceService = {
  /**
   * Record that this user has agreed to the re-consent set as it stands NOW.
   *
   * ⚠️ THE VERSIONS COME FROM THE SERVER, NEVER FROM THE CALLER. Nothing in the
   * signature lets a client say which version it agreed to: the row is evidence
   * of what we SHOWED, and a version a browser supplied is evidence of what a
   * browser claimed. It is also why the interstitial does not need to round-trip
   * the versions it rendered — a document that moved between the render and the
   * submit is caught on the next page load by the gate, which is exactly the
   * mechanism that already exists for it.
   *
   * Idempotent: re-recording an acceptance the person already holds writes
   * nothing. Returns the number of rows genuinely created.
   */
  async recordAcceptance(userId: string): Promise<number> {
    // ⚠️ NO EMPTY-SET GUARD HERE, DELIBERATELY. A deployment whose
    // `content/legal/` holds none of the three documents is not a case this
    // method has to recognise: `createMany` already returns 0 for an empty
    // batch without touching the database, and `outstandingReconsent` already
    // answers `[]` for an empty document list. A second guard at this tier would
    // duplicate a decision that is made — and tested — one layer down, and the
    // only thing it could buy is skipping a transaction that does nothing.
    const documents = reconsentDocuments();

    // ONE timestamp for the whole act. `terms.md` §15 makes the three documents
    // a single agreement and the interstitial offers a single button, so three
    // rows a few milliseconds apart would misrepresent one decision as three.
    const acceptedAt = new Date();
    const rows = documents.map((document) => ({
      userId,
      documentSlug: document.slug,
      version: document.version,
      acceptedAt,
    }));

    return withUserContext(userId, (tx) => legalAcceptanceRepository.createMany(rows, tx));
  },

  /**
   * The documents this user must re-accept before they carry on — empty for
   * almost every request, which is the answer this path is shaped around.
   *
   * ONE query, three slugs, on an index whose prefix is `user_id`. It runs
   * inside the signed-in layouts' existing concurrent wave rather than as an
   * extra sequential round trip (`app/(authed)/layout.tsx`, MOTIR-3433).
   */
  async resolveOutstanding(userId: string): Promise<OutstandingDocument[]> {
    const documents = reconsentDocuments();

    const held = await withUserContext(userId, (tx) =>
      legalAcceptanceRepository.findByUserAndSlugs(userId, RECONSENT_DOCUMENT_SLUGS, tx),
    );
    return outstandingReconsent(documents, held);
  },
};
