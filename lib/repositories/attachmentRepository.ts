import { Prisma, type Attachment, type AttachmentSource } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Single-op data access for the `attachment` table (Subtask 2.3.7 upload leaf;
// Subtask 5.2.1 adds the work_item-link management methods). Writes require
// `tx` (the 4-layer rule). Tenant paths run under withWorkspaceContext so the
// RLS policy's `app.workspace_id` GUC is bound; the orphan-GC (5.2.7) runs its
// reads + deletes under withSystemContext instead (the policy's
// `app.system_admin` hatch, added in the 5.2.1 migration).
/**
 * The sources a LIFECYCLE owns, which the generic attachments panel never lists.
 *
 * Each of these is linked to its work item only so the orphan-GC spares it; the
 * rows are rendered by the panel that owns their lifecycle — the acceptance
 * panel for a recording and its trace, the Design result panel for a published
 * design asset. A `.zip` Playwright trace in the general attachments panel is
 * noise to the reviewer that panel is for, and it inherits affordances its
 * lifecycle never intended (panel delete, which would strand
 * `AcceptanceEvidence.traceAttachmentId`).
 *
 * ⚠️ ONE CONSTANT, USED BY BOTH QUERIES (MOTIR-3085). The list and the count
 * carried this predicate independently and had already drifted:
 * `acceptance_trace` was documented in `schema.prisma` as excluded and was in
 * neither array, so every story with a trace-carrying recording showed it. A
 * denylist written twice is a denylist that will disagree with itself; written
 * once, the badge cannot contradict the list it labels.
 */
export const LIFECYCLE_OWNED_SOURCES: readonly AttachmentSource[] = [
  'acceptance_video',
  'acceptance_trace',
  'design_asset',
];

export const attachmentRepository = {
  async create(
    data: Prisma.AttachmentUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Attachment> {
    return tx.attachment.create({ data });
  },

  /**
   * One row by id — the delete path's resolve (5.2.2). Takes `tx` when called
   * inside the delete transaction (the read guards the subsequent write); the
   * service applies the workspace-scoping + linked checks (a repo is a leaf).
   */
  /**
   * ⚠️ `tx` is REQUIRED (MOTIR-2797). It carried a `tx ?? dbRead` fallback until every
   * caller bound its read; the arm then had no caller, so it was dead code that
   * returned an EMPTY result under `motir_app` and raised nothing — the exact
   * silent failure this cutover exists to remove. A branch that cannot be
   * honestly exercised in both role modes should not exist. Same disposition
   * MOTIR-2755 gave projectRoleDefinitionRepository.
   */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<Attachment | null> {
    return tx.attachment.findUnique({ where: { id } });
  },

  /**
   * One issue's attachments, newest first — the paged panel read (5.2.2),
   * backed by the (work_item_id, created_at DESC) index. Cursor-paginated like
   * workItemRevisionRepository.listByWorkItem: `cursor` is an attachment id,
   * and when present the row AT the cursor is skipped (`skip: 1`) so paging
   * doesn't repeat it. `id` is the required secondary sort: `createdAt` alone
   * is not a total order (a multi-file upload writes rows in the same
   * millisecond), and an unbroken tie makes cursor pagination skip or repeat
   * rows at a page boundary (PRODECT_FINDINGS #38).
   */
  async listByWorkItem(
    workItemId: string,
    options: { take?: number; cursor?: string } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<Attachment[]> {
    const { take = 50, cursor } = options;
    const client = tx ?? dbRead;
    return client.attachment.findMany({
      // The lifecycle-owned sources never reach this panel — see
      // LIFECYCLE_OWNED_SOURCES for which and why.
      where: { workItemId, source: { notIn: [...LIFECYCLE_OWNED_SOURCES] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /** The panel's total count ("Show more (N)" + the header badge, 5.2.2). */
  async countByWorkItem(workItemId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? dbRead;
    // The SAME predicate the listing uses, from the same constant — the badge
    // and the list cannot disagree.
    return client.attachment.count({
      where: { workItemId, source: { notIn: [...LIFECYCLE_OWNED_SOURCES] } },
    });
  },

  /**
   * The link-on-write lookup (5.2.3; id-based since MOTIR-1668): resolve the
   * attachment IDS a Markdown body references (via their content path) to rows.
   * WORKSPACE-SCOPED so a foreign id pasted into a body never resolves a foreign
   * workspace's row (defence in depth with the RLS gate — finding #26). Empty
   * input short-circuits to [] without touching the DB.
   */
  /**
   * ⚠️ `tx` is REQUIRED (MOTIR-2797). It carried a `tx ?? dbRead` fallback until every
   * caller bound its read; the arm then had no caller, so it was dead code that
   * returned an EMPTY result under `motir_app` and raised nothing — the exact
   * silent failure this cutover exists to remove. A branch that cannot be
   * honestly exercised in both role modes should not exist. Same disposition
   * MOTIR-2755 gave projectRoleDefinitionRepository.
   */
  async findManyByIds(
    workspaceId: string,
    ids: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Attachment[]> {
    if (ids.length === 0) return [];
    return tx.attachment.findMany({ where: { workspaceId, id: { in: ids } } });
  },

  /**
   * Link rows to an issue, stamping how they entered (`source`) — the panel
   * upload links one row as 'panel' (5.2.2); the link-on-write parse links the
   * body's newly-referenced rows as 'editor' (5.2.3). Returns the updated
   * count. Empty input is a no-op returning 0.
   */
  async linkToWorkItem(
    ids: string[],
    workItemId: string,
    source: AttachmentSource,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.attachment.updateMany({
      where: { id: { in: ids } },
      data: { workItemId, source },
    });
    return result.count;
  },

  /**
   * Unlink rows from their issue (a body edit de-referenced them, 5.2.3) —
   * the row survives, GC-eligible (5.2.7). `source` is kept as-is: it records
   * how the row entered, not whether it is currently linked. Empty input is a
   * no-op returning 0.
   */
  async unlinkFromWorkItem(ids: string[], tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.attachment.updateMany({
      where: { id: { in: ids } },
      data: { workItemId: null },
    });
    return result.count;
  },

  /**
   * Re-point every attachment of one work item onto another (Story 6.11 ·
   * Subtask 6.11.5 — mark-duplicate / merge). The triage-merge action folds a
   * duplicate submission's attachments into the canonical item — mirroring
   * Linear moving attachments to the canonical issue. `source` is kept as-is
   * (it records how the row entered, not which issue holds it). Required `tx` —
   * commits atomically with the duplicate's cancel. Returns the count moved.
   */
  async reassignWorkItem(
    fromWorkItemId: string,
    toWorkItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.attachment.updateMany({
      where: { workItemId: fromWorkItemId },
      data: { workItemId: toWorkItemId },
    });
    return result.count;
  },

  /** Hard-delete one row (5.2.7 GC sweep). No tombstone. */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<Attachment> {
    return tx.attachment.delete({ where: { id } });
  },

  /**
   * Idempotent hard-delete (5.2.2's post-blob row removal) — `deleteMany` by
   * id so an already-gone row (a concurrent GC pass took it while it was
   * briefly unlinked) is a 0-count success, not a P2025 throw. Returns the
   * deleted count.
   */
  async deleteIfExists(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.attachment.deleteMany({ where: { id } });
    return result.count;
  },

  /**
   * Unlinked rows older than the safety window — the orphan-GC read (5.2.7).
   * Oldest first so the sweep retires the longest-stranded rows first, with
   * the same cursor+skip pagination as listByWorkItem so a backlog is walked
   * in bounded batches, never one unbounded read (finding #57). Runs under
   * withSystemContext (cross-workspace by design — the RLS system_admin
   * hatch); the (work_item_id, created_at DESC) index serves the
   * IS NULL + createdAt range scan.
   */
  /**
   * ⚠️ `tx` is REQUIRED (MOTIR-2797). It carried a `tx ?? dbRead` fallback until every
   * caller bound its read; the arm then had no caller, so it was dead code that
   * returned an EMPTY result under `motir_app` and raised nothing — the exact
   * silent failure this cutover exists to remove. A branch that cannot be
   * honestly exercised in both role modes should not exist. Same disposition
   * MOTIR-2755 gave projectRoleDefinitionRepository.
   */
  async listOrphans(
    options: { olderThan: Date; take?: number; cursor?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Attachment[]> {
    const { olderThan, take = 200, cursor } = options;
    return tx.attachment.findMany({
      where: { workItemId: null, createdAt: { lt: olderThan } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Total bytes stored by an organization (§4.3b cap, 8.1.11) —
   * `SUM(Attachment.sizeBytes)` over every attachment in every workspace of the
   * org, joined `attachment → workspace`. The §4 v1 strategy: SUM on upload (a
   * cached running counter is a later optimization); a single-file race overage
   * is benign (storage, not money — no FOR UPDATE), so `tx` is OPTIONAL and the
   * upload path calls it as a standalone read before the blob round-trip.
   * `COALESCE(...,0)` so an org with no attachments returns 0, not null.
   */
  async sumSizeByOrganization(
    organizationId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(a."size_bytes"), 0) AS total
      FROM "attachment" a
      JOIN "workspace" w ON w."id" = a."workspace_id"
      WHERE w."organizationId" = ${organizationId}
    `;
    return Number(rows[0]?.total ?? 0);
  },
};
