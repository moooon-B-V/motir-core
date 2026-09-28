'use server';

import { getSession } from '@/lib/auth';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import { VisitorConsentNotApplicableError } from '@/lib/visitor/errors';

// The consent screen's one write (Story MOTIR-6170 · MOTIR-6669). Route-layer
// equivalent per `CLAUDE.md`: read the session, call exactly one service method,
// translate its typed errors. No `db.*`, no `$transaction` — the service owns them.

/** What Continue learns: recorded, gone, or a member who never needed to agree. */
export type RecordVisitorConsentResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'member' };

/**
 * Record the signed-in reader's consent on `identifier`.
 *
 * ⚠️ IT TAKES ONLY THE PROJECT'S KEY. WHO consents is the session's user, never a
 * value the browser sent, and the service re-resolves the project, so a project
 * made private since the screen was drawn is refused as not-found and a member is
 * refused with nothing written. Idempotent: a double press records one consent.
 */
export async function recordVisitorConsentAction(
  identifier: string,
): Promise<RecordVisitorConsentResult> {
  const session = await getSession();
  if (!session) throw new Error('UNAUTHENTICATED');
  try {
    await visitorRecordsService.recordConsent({ identifier, userId: session.user.id });
    return { ok: true };
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return { ok: false, reason: 'not_found' };
    if (err instanceof VisitorConsentNotApplicableError) return { ok: false, reason: 'member' };
    throw err;
  }
}
