import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { DesignEvidenceWithAssets } from '@/lib/mappers/designEvidenceMappers';

// Single-op data access for the `design_evidence` / `design_asset` tables
// (Story MOTIR-2664 · Subtask MOTIR-2666). Writes require `tx` (the 4-layer
// rule). Every tenant path runs under withWorkspaceContext so the RLS policies'
// `app.workspace_id` GUC is bound (pure workspace gate on BOTH tables — no
// system_admin hatch, mirroring `attachment` / `acceptance_evidence`).

/** Assets always come back in render order — one place decides it. */
const WITH_ASSETS = {
  assets: { include: { attachment: true }, orderBy: { position: 'asc' } },
} satisfies Prisma.DesignEvidenceInclude;

export const designEvidenceRepository = {
  async create(
    data: Prisma.DesignEvidenceUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DesignEvidenceWithAssets> {
    return tx.designEvidence.create({ data, include: WITH_ASSETS });
  },

  /** Insert one artifact row of a result. */
  async createAsset(
    data: Prisma.DesignAssetUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.designAsset.create({ data });
  },

  /**
   * The CURRENT design result for a work item (the panel's head read), with its
   * assets and their Attachments. Takes `tx` when called inside the supersede
   * transaction (the read guards the subsequent write); the pure-read panel path
   * uses the `db` singleton under an already-bound workspace context.
   */
  async findCurrentByWorkItem(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DesignEvidenceWithAssets | null> {
    const client = tx ?? db;
    return client.designEvidence.findFirst({
      where: { workItemId, isCurrent: true },
      include: WITH_ASSETS,
    });
  },

  /** One result by id, with its assets (the re-read after asset inserts). */
  async findById(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<DesignEvidenceWithAssets | null> {
    const client = tx ?? db;
    return client.designEvidence.findUnique({ where: { id }, include: WITH_ASSETS });
  },

  /**
   * LOCK the current row for a work item before the supersede decides on it.
   * The supersede is read-derived — it reads which row is current, then writes
   * based on that — so a plain read-then-write races: two publishes both read
   * the same current row and both try to take the `WHERE is_current` slot. The
   * `FOR UPDATE` makes the second wait, so it observes the first's outcome
   * (the lock-before-read-derived-update rule in CLAUDE.md).
   *
   * Returns the locked row ids (empty when the item has no current result).
   */
  async lockCurrentByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "design_evidence"
      WHERE "work_item_id" = ${workItemId} AND "is_current"
      FOR UPDATE
    `;
    return rows.map((r) => r.id);
  },

  /**
   * Mark every current row for a work item superseded (is_current → false) — the
   * first half of a supersede (the caller then unlinks the old assets'
   * attachments so the orphan-GC reclaims their blobs, and inserts the new
   * current row). Clears the `WHERE is_current` partial-unique slot so the new
   * insert can take it. Returns the affected count.
   */
  async markSupersededByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.designEvidence.updateMany({
      where: { workItemId, isCurrent: true },
      data: { isCurrent: false },
    });
    return result.count;
  },
};
