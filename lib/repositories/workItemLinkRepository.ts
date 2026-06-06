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
   * Look up the single link with the exact (fromId, toId, kind) triple via
   * the @@unique([fromId, toId, kind]) index (Subtask 1.4.4). Named
   * "reciprocal" because its caller is the `relates_to` unlink path: given
   * the A→B link being removed, it resolves the B→A mirror row so both
   * halves of the symmetric pair drop together. Takes an optional `tx` so
   * the read joins the same transaction as the deletes it gates.
   */
  async findReciprocal(
    fromId: string,
    toId: string,
    kind: WorkItemLinkKind,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemLink | null> {
    const client = tx ?? db;
    return client.workItemLink.findUnique({
      where: { fromId_toId_kind: { fromId, toId, kind } },
    });
  },

  /**
   * The `(status, projectId)` of every `is_blocked_by` blocker of `workItemId`
   * — the raw input the service's `isReady` reduces to a readiness verdict
   * (Subtask 2.2.6, resolving finding #21). ONE query, no fetch-then-filter
   * loop; the terminal classification is NOT done here because "terminal" is a
   * per-project property (`category = done`, which can differ per blocker's
   * project) — that lives in `workflowsService.getTerminalStatusKeysByProjects`
   * and the service composes the two. (Earlier this was a single COUNT query
   * with a hardcoded `status <> 'done'`; finding #21 generalized it.)
   *
   * A blocker can live in a DIFFERENT project than `workItemId` (cross-project
   * blocks are legal in the link model), so each blocker carries its own
   * `projectId`. The blocker's `id` rides along too so a caller naming the OPEN
   * blockers (the 2.4.5 readiness banner) can correlate this row back to the
   * resolved blocker summary without a second lookup. Read-only → `db` singleton.
   */
  async findBlockerStates(
    workItemId: string,
  ): Promise<Array<{ id: string; status: string; projectId: string }>> {
    const rows = await db.workItemLink.findMany({
      where: { fromId: workItemId, kind: 'is_blocked_by' },
      select: { toItem: { select: { id: true, status: true, projectId: true } } },
    });
    return rows.map((r) => ({
      id: r.toItem.id,
      status: r.toItem.status,
      projectId: r.toItem.projectId,
    }));
  },

  /**
   * Batched form of {@link findBlockerStates} for MANY items at once — the board
   * projection (3.1.4) needs a ready flag per card without an N+1. Returns every
   * `is_blocked_by` blocker of any item in `fromIds`, each row carrying the
   * blocked item it belongs to (`fromId`) plus the blocker's `status` +
   * `projectId` for per-project terminal classification. ONE query. Empty
   * `fromIds` short-circuits to `[]`. Read-only → `db` singleton.
   */
  async findBlockerStatesForItems(
    fromIds: string[],
  ): Promise<Array<{ fromId: string; status: string; projectId: string }>> {
    if (fromIds.length === 0) return [];
    const rows = await db.workItemLink.findMany({
      where: { fromId: { in: fromIds }, kind: 'is_blocked_by' },
      select: { fromId: true, toItem: { select: { status: true, projectId: true } } },
    });
    return rows.map((r) => ({
      fromId: r.fromId,
      status: r.toItem.status,
      projectId: r.toItem.projectId,
    }));
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
    /* istanbul ignore else -- defensive: within a 23514 block the four WI_LINK markers are exhaustive, so "not a self-link here" is unreachable */
    if (message.includes('WI_LINK_SELF')) {
      throw new SelfLinkError();
    }
  }

  /* istanbul ignore else -- defensive: a non-Prisma error never reaches here (every link write error is a 23514 trigger or a Prisma known-request error) */
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    /* istanbul ignore else -- defensive: P2002 (the (fromId,toId,kind) unique) is the only Prisma code this write produces */
    if (err.code === 'P2002') throw new DuplicateLinkError();
  }

  /* istanbul ignore next -- defensive rethrow: every work_item_link write error is a 23514 trigger marker or a Prisma P2002, all handled above */
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
      /* istanbul ignore next -- defensive: the @prisma/adapter-pg error exposes `code`; `originalCode` is a fallback for a future driver shape */
      if (typeof c.originalCode === 'string') return c.originalCode;
    }
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  /* istanbul ignore next -- defensive: work_item_link write errors are always Error instances; these branches guard a non-Error throw */
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  /* istanbul ignore next -- defensive: see above */
  return String(err);
}
