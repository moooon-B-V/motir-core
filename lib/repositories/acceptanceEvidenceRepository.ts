import { Prisma, type AcceptanceEvidenceStatus } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { AcceptanceEvidenceWithAttachment } from '@/lib/mappers/acceptanceEvidenceMappers';

// Single-op data access for the `acceptance_evidence` table (Story MOTIR-1627 ·
// Subtask MOTIR-1629). Writes require `tx` (the 4-layer rule). Every tenant path
// runs under withWorkspaceContext so the RLS policy's `app.workspace_id` GUC is
// bound (pure workspace gate — no system_admin hatch, mirroring `attachment`).
export const acceptanceEvidenceRepository = {
  async create(
    data: Prisma.AcceptanceEvidenceUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AcceptanceEvidenceWithAttachment> {
    return tx.acceptanceEvidence.create({
      data,
      include: { attachment: true, traceAttachment: true },
    });
  },

  /**
   * The CURRENT evidence for a story (the acceptance panel's head read), with
   * its joined video Attachment. Takes `tx` when called inside the supersede
   * transaction (the read guards the subsequent write); the pure-read panel
   * path uses the `db` singleton under an already-bound workspace context.
   */
  async findCurrentByWorkItem(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AcceptanceEvidenceWithAttachment | null> {
    const client = tx ?? db;
    return client.acceptanceEvidence.findFirst({
      where: { workItemId, isCurrent: true },
      include: { attachment: true, traceAttachment: true },
    });
  },

  /** One evidence row by id (the status-update resolve), with its attachment. */
  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AcceptanceEvidenceWithAttachment | null> {
    const client = tx ?? db;
    return client.acceptanceEvidence.findUnique({
      where: { id },
      include: { attachment: true, traceAttachment: true },
    });
  },

  /**
   * Lock the story's CURRENT receipt FOR UPDATE and return its status — the
   * freeze gate's read (MOTIR-2764). The service reads the status under the lock
   * before deriving whether it may supersede (the lock-before-read-derived-update
   * rule), so two concurrent publishes for the same story cannot both see a
   * replaceable `pending` row and both write.
   *
   * ⚠️ BOTH SIDES OF THE SEAM TAKE THIS LOCK, AND THAT IS THE POINT (MOTIR-2851).
   * `acceptanceEvidenceService.decide` calls it too, before deriving which row an
   * approval stamps. A lock only serialises the paths that TAKE it: while the
   * publish held it alone, an approval could stamp the very row the publish was
   * superseding, leaving an `approved` receipt with `isCurrent: false` and
   * unlinked attachments. Do not "simplify" either caller back out of it.
   *
   * Deliberately NOT folded into a status predicate on `markSupersededByWorkItem`:
   * a supersede that silently affects zero rows would let the insert proceed and
   * collide with the partial-unique slot, surfacing a P2002 instead of the typed
   * refusal a caller can branch on. Returns null when the story has no receipt yet.
   */
  async lockCurrentStatusByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; status: AcceptanceEvidenceStatus } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: AcceptanceEvidenceStatus }>>`
      SELECT "id", "status"
      FROM "acceptance_evidence"
      WHERE "work_item_id" = ${workItemId} AND "is_current" = true
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Mark every current row for a story superseded (is_current → false) — the
   * first half of a supersede (the caller then unlinks the old video so the
   * orphan-GC reclaims its blob, and inserts the new current row). Clears the
   * `WHERE is_current` partial-unique slot so the new insert can take it.
   * Returns the affected count.
   *
   * ⚠️ Carries NO status predicate BY DESIGN — the freeze decision belongs to the
   * service, which takes `lockCurrentStatusByWorkItem` above first and refuses an
   * `approved` receipt with a typed error. Do not add one here in the belief it
   * makes this safer; it would make the refusal a silent no-op.
   */
  async markSupersededByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.acceptanceEvidence.updateMany({
      where: { workItemId, isCurrent: true },
      data: { isCurrent: false },
    });
    return result.count;
  },

  /**
   * The subset of `workItemIds` whose CURRENT evidence is `pending` — the board
   * "Awaiting acceptance" batch (MOTIR-1636). ONE query over the candidate ids
   * (no N+1); empty input short-circuits without a DB round-trip.
   */
  async findPendingWorkItemIds(
    workItemIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (workItemIds.length === 0) return [];
    const client = tx ?? db;
    const rows = await client.acceptanceEvidence.findMany({
      where: { workItemId: { in: workItemIds }, isCurrent: true, status: 'pending' },
      select: { workItemId: true },
    });
    return rows.map((r) => r.workItemId);
  },

  /** Set the acceptance status (+ approver stamp on approve) for one row. */
  async updateStatus(
    id: string,
    data: {
      status: AcceptanceEvidenceStatus;
      approvedById: string | null;
      approvedAt: Date | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<AcceptanceEvidenceWithAttachment> {
    return tx.acceptanceEvidence.update({
      where: { id },
      data,
      include: { attachment: true, traceAttachment: true },
    });
  },
};
