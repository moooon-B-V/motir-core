'use server';

import { getSession } from '@/lib/auth';
import { legalAcceptanceService } from '@/lib/services/legalAcceptanceService';

// The re-consent interstitial's one write (Story 8.4 · Subtask MOTIR-1135).
// Route-layer equivalent per `CLAUDE.md`: read the session, call exactly one
// service method. No `db.*`, no `$transaction` — the service owns those.

/**
 * Record that the signed-in reader agrees to the re-consent set as it stands.
 *
 * ⚠️ IT TAKES NO ARGUMENTS, AND THAT IS THE SECURITY PROPERTY. The versions
 * recorded are the ones the SERVER reads off disk at this instant, never a value
 * the browser sent — the row is evidence of what we published, and a version a
 * client supplied is evidence of what a client claimed. It also means a document
 * that moved between the render and this submit cannot be accepted by accident:
 * whatever is current is what gets recorded, and if something is still
 * outstanding afterwards the gate simply asks again on the next page load.
 *
 * Idempotent all the way down (the repository's `skipDuplicates` on the
 * (user, document, version) key), so a double-submitted form records one
 * agreement with one timestamp rather than two.
 */
export async function acceptCurrentLegalDocumentsAction(): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');

  await legalAcceptanceService.recordAcceptance(session.user.id);
}
