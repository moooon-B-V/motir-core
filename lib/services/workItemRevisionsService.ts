// =================================================================
// Revision-audit service for the work-item domain (Subtask 1.4.6). Every
// workItemsService write — create / update / archive / link / unlink — calls
// `recordRevision` to persist ONE audit row describing the mutation, INSIDE
// the same transaction as the mutation itself. The required `tx` parameter is
// the contract that enforces this: a revision commits atomically with the
// mutation it describes, or neither does. If the work-item write lands but the
// revision write throws (or vice versa), the enclosing $transaction rolls back
// BOTH — the audit trail can never silently diverge from the data. The
// atomicity integration test (tests/integration/work-items/revisions.test.ts)
// exercises exactly this rollback.
//
// The signature + RecordRevisionArgs shape were locked in by Subtask 1.4.4
// (which shipped this file as a no-op stub so every call site already passed
// the right args). 1.4.6 swapped the body from no-op to a real persist via
// workItemRevisionRepository — call sites are unchanged.
//
// Layer rules (CLAUDE.md): this service owns no transaction of its own — it is
// always invoked inside the caller's $transaction and threads the caller's
// `tx` straight into the repository write (single-op leaf). It performs no DTO
// mapping (it returns void; reads + mapping live on the read path).

import type { Prisma } from '@prisma/client';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';

/** The audit verb for a revision row — mirrors WorkItemRevisionDto.changeKind. */
export type RevisionChangeKind = 'created' | 'updated' | 'archived';

/**
 * The arguments a service write passes when recording a revision. `diff` is
 * intentionally loose (`Record<string, unknown>`) so it accommodates BOTH
 * the field-diff shape ({ title: { from, to }, … }) the create/update/move
 * paths produce AND the link-diff shape ({ links: { added: [...] } }) the
 * link/unlink paths produce. The persisted column is JSON; the
 * WorkItemRevisionDto pins the wire shape at the read boundary.
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
   * mutation it describes, or not at all).
   */
  async recordRevision(args: RecordRevisionArgs, tx: Prisma.TransactionClient): Promise<void> {
    await workItemRevisionRepository.create(
      {
        workItemId: args.workItemId,
        changedById: args.changedById,
        changeKind: args.changeKind,
        diff: args.diff as Prisma.InputJsonValue,
      },
      tx,
    );
  },
};
