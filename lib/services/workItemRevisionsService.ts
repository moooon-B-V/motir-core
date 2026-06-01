// 1.4.6 fills in.
// =================================================================
// Revision-audit service for the work-item domain. The WorkItemRevision
// table itself lands in Subtask 1.4.6 (revision audit) — THIS file ships the
// CALL SITE now so every workItemsService write already records its revision
// with the right args inside the same transaction. 1.4.6 only swaps the body
// of `recordRevision` to persist the row (via a workItemRevisionRepository);
// the service-layer contract — "every create/update/archive/link/unlink
// emits a revision atomically with the mutation" — is locked in here.
//
// Until then the body is a no-op. The args are typed (not `any`) so the
// call sites are checked today and 1.4.6's change is body-only. Atomicity-of-
// revision tests are 1.4.6's territory; this Subtask only locks the shape.

import type { Prisma } from '@prisma/client';

/** The audit verb for a revision row — mirrors WorkItemRevisionDto.changeKind. */
export type RevisionChangeKind = 'created' | 'updated' | 'archived';

/**
 * The arguments a service write passes when recording a revision. `diff` is
 * intentionally loose (`Record<string, unknown>`) so it accommodates BOTH
 * the field-diff shape ({ title: { from, to }, … }) the create/update/move
 * paths produce AND the link-diff shape ({ links: { added: [...] } }) the
 * link/unlink paths produce. 1.4.6 will tighten the persisted JSON shape; the
 * call sites already hand it the right data.
 */
export interface RecordRevisionArgs {
  workItemId: string;
  changedById: string;
  changeKind: RevisionChangeKind;
  diff: Record<string, unknown>;
}

export const workItemRevisionsService = {
  /**
   * Record a revision row for a work-item mutation, inside the caller's
   * transaction (required `tx` — a revision must commit atomically with the
   * mutation it describes, or not at all). No-op until 1.4.6 lands the table.
   */
  async recordRevision(_args: RecordRevisionArgs, _tx: Prisma.TransactionClient): Promise<void> {
    // TODO(1.4.6): persist revision row when the table lands.
  },
};
