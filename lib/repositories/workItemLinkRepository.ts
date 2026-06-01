import { Prisma, type WorkItemLink, type WorkItemLinkKind } from '@prisma/client';
import { db } from '@/lib/db';
import {
  CrossWorkspaceLinkError,
  DuplicateLinkError,
  SelfLinkError,
  WorkItemLinkCycleError,
  WorkspaceMismatchLinkError,
} from '@/lib/workItems/linkErrors';

// Work-item-link repository — single Prisma operations on the
// `work_item_link` table. Writes require `tx` (compile-time guarantee they
// run in a transaction); pure read paths use the `db` singleton. No business
// logic, no transactions, no DTO mapping here — those belong in the link-
// service in 1.4.4 (which will own the same-workspace + same-project
// validation reads, the cross-axis reciprocal `relates_to` writes, and the
// permission checks).
//
// The DB-layer triggers (prisma/sql/work_item_link_triggers.sql) enforce the
// cycle / self-link / workspace-consistency rules. On INSERT / UPDATE they
// reject with SQLSTATE 23514 + a WI_LINK_* message marker; `create`
// translates those markers into the typed errors from lib/workItems/
// linkErrors.ts at this edge, so the service layer never inspects raw
// Postgres error codes (the 4-layer rule). Prisma P2002 on the
// (fromId, toId, kind) unique constraint translates to DuplicateLinkError.

export const workItemLinkRepository = {
  /**
   * Look up a single link by id. Read-only, uses the `db` singleton.
   */
  async findById(id: string): Promise<WorkItemLink | null> {
    return db.workItemLink.findUnique({ where: { id } });
  },

  /**
   * Links whose `fromId` is the given work item — i.e., the OUT edges. With
   * no `kind` filter, returns every kind (the typical "show all links on
   * this issue" endpoint feeds from a from + to merge). With a `kind`
   * filter, narrows to the indexed `(fromId, kind)` lookup.
   */
  async findByFromItem(fromId: string, kind?: WorkItemLinkKind): Promise<WorkItemLink[]> {
    return db.workItemLink.findMany({
      where: { fromId, ...(kind ? { kind } : {}) },
    });
  },

  /**
   * Links whose `toId` is the given work item — i.e., the IN edges. The
   * mirror of findByFromItem; for `is_blocked_by` this is the "what does
   * this item block?" reverse lookup the ready-set engine needs.
   */
  async findByToItem(toId: string, kind?: WorkItemLinkKind): Promise<WorkItemLink[]> {
    return db.workItemLink.findMany({
      where: { toId, ...(kind ? { kind } : {}) },
    });
  },

  /**
   * Create a link. Required `tx`. The DB triggers validate cycle /
   * self-link / workspace consistency on insert; their SQLSTATE-23514
   * rejections and a P2002 unique violation are translated to typed errors
   * here. Accepts the unchecked input shape (fromId/toId/workspaceId/
   * createdById as scalar FKs) for parity with workItemRepository.create.
   */
  async create(
    data: Prisma.WorkItemLinkUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemLink> {
    try {
      return await tx.workItemLink.create({ data });
    } catch (err) {
      throw translateWriteError(err, {
        fromId: data.fromId,
        toId: data.toId,
        kind: data.kind as string,
      });
    }
  },

  /**
   * Delete a link by id. Required `tx`. Returns the deleted row. The repo
   * does not soft-delete links: revoking a dependency edge is a data-model
   * operation, not a history-preserving one (revision audit on links lives
   * with the parent issue's revision rows in 1.4.6 if at all).
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<WorkItemLink> {
    return tx.workItemLink.delete({ where: { id } });
  },
};

// --- Prisma/Postgres error → typed error translation (repository edge) ------

/**
 * Translate a write-path error into a typed work-item-link error. Trigger
 * rejections arrive (via the pg driver adapter) as an error whose
 * `cause.code` is SQLSTATE 23514 and whose message carries one of the
 * WI_LINK_* markers; we key on the marker (unique strings we control) and
 * confirm via the SQLSTATE. P2002 → duplicate link. Anything else is
 * rethrown unchanged. Always throws — return type is `never`.
 *
 * The marker check uses the literal string per branch (rather than a single
 * pre-extracted set) so the produced typed error carries the most specific
 * class even when two markers share a prefix.
 */
function translateWriteError(
  err: unknown,
  attempted: { fromId: string; toId: string; kind: string },
): never {
  const message = extractMessage(err);
  const sqlState = extractSqlState(err);

  if (sqlState === '23514' || isLinkTriggerMarker(message)) {
    if (message.includes('WI_LINK_CYCLE')) {
      throw new WorkItemLinkCycleError(attempted);
    }
    if (message.includes('WI_LINK_CROSS_WORKSPACE')) {
      throw new CrossWorkspaceLinkError();
    }
    if (message.includes('WI_LINK_WORKSPACE_MISMATCH')) {
      throw new WorkspaceMismatchLinkError();
    }
    if (message.includes('WI_LINK_SELF')) {
      throw new SelfLinkError();
    }
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') throw new DuplicateLinkError();
  }

  throw err;
}

function isLinkTriggerMarker(message: string): boolean {
  return (
    message.includes('WI_LINK_CYCLE') ||
    message.includes('WI_LINK_CROSS_WORKSPACE') ||
    message.includes('WI_LINK_WORKSPACE_MISMATCH') ||
    message.includes('WI_LINK_SELF')
  );
}

/** SQLSTATE from a pg driver-adapter error's `cause`, if present. */
function extractSqlState(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      const c = cause as { code?: unknown; originalCode?: unknown };
      if (typeof c.code === 'string') return c.code;
      if (typeof c.originalCode === 'string') return c.originalCode;
    }
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
