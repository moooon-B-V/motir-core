import type { Prisma } from '@/generated/prisma/client';
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
  /**
   * ⚠️ `tx` is REQUIRED (MOTIR-2797). It carried a `tx ?? db` fallback until every
   * caller bound its read; the arm then had no caller, so it was dead code that
   * returned an EMPTY result under `motir_app` and raised nothing — the exact
   * silent failure this cutover exists to remove. A branch that cannot be
   * honestly exercised in both role modes should not exist. Same disposition
   * MOTIR-2755 gave projectRoleDefinitionRepository.
   */
  async findCurrentByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DesignEvidenceWithAssets | null> {
    return tx.designEvidence.findFirst({
      where: { workItemId, isCurrent: true },
      include: WITH_ASSETS,
    });
  },

  /** One result by id, with its assets (the re-read after asset inserts). */
  /**
   * ⚠️ `tx` is REQUIRED (MOTIR-2797). It carried a `tx ?? db` fallback until every
   * caller bound its read; the arm then had no caller, so it was dead code that
   * returned an EMPTY result under `motir_app` and raised nothing — the exact
   * silent failure this cutover exists to remove. A branch that cannot be
   * honestly exercised in both role modes should not exist. Same disposition
   * MOTIR-2755 gave projectRoleDefinitionRepository.
   */
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<DesignEvidenceWithAssets | null> {
    return tx.designEvidence.findUnique({ where: { id }, include: WITH_ASSETS });
  },

  /**
   * SEVERAL results by id, with a COUNT of their assets — the Approvals tab's
   * subject summaries, loaded for a whole page in one round trip (Story
   * MOTIR-4879 · Subtask MOTIR-4791).
   *
   * ⚠️ A BATCH RATHER THAN N CALLS TO {@link findById}, and the shape of the
   * caller is why. A queue page holds up to `HOME_PAGE_SIZE` gates and every one
   * of them needs its subject named, so the per-id read would be 25 queries to
   * render one list — the N+1 that a paged surface turns from a smell into a
   * cost the reader pays on every page.
   *
   * ⚠️ IT COUNTS ASSETS RATHER THAN INCLUDING THEM. {@link findById}'s
   * `WITH_ASSETS` joins every asset AND its Attachment because the panel renders
   * them; a ROW says *three files* and links away. Including them here would
   * fetch a page's worth of attachment rows to render a number.
   *
   * Returned as a MAP keyed by id, because the caller has gate rows in the
   * query's order and needs to look each subject up rather than re-sort — and
   * because a subject that no longer resolves must be ABSENT rather than
   * silently shifting the list (ADR §6a: a gate's subject can stop resolving,
   * and the honest answer is to say so on the row).
   */
  async findManyByIds(
    ids: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, DesignEvidenceSummaryRow>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.designEvidence.findMany({
      where: { id: { in: ids } },
      select: DESIGN_EVIDENCE_SUMMARY_SELECT,
    });
    return new Map(rows.map((row) => [row.id, row]));
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

  /**
   * PIN one row's bytes against the orphan-GC — the retention half of an
   * approval (MOTIR-4913; ADR §6c and its MOTIR-4911 amendment).
   *
   * ⚠️ It writes ONLY `pinned_at`, and only when the row does not already carry
   * one. The guard is not a concurrency device — the caller holds this row's
   * `FOR UPDATE` lock from {@link lockCurrentByWorkItem} — it is what makes the
   * FIRST approval's timestamp the one that survives a re-approval of the same
   * version. §6d's *per approved version* accumulates across DIFFERENT rows; the
   * same row pinned twice is one retention decision, and re-stamping it would
   * quietly move the date of a decision somebody made earlier.
   *
   * ⚠️ A zero-row result is a legitimate answer here, unlike the silent no-op
   * `approvalGateRepository.decide` refuses to build: both of its causes are
   * correct end states — the row is already pinned, or a concurrent publish
   * superseded it out from under the lock — and neither is a refusal being
   * swallowed. The caller reports which by re-reading, never by inferring from
   * the count.
   */
  async pinById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.designEvidence.updateMany({
      where: { id, pinnedAt: null },
      data: { pinnedAt: new Date() },
    });
    return result.count;
  },

  /**
   * WITHDRAW one row by id — `is_current → false` with NOTHING taking the slot,
   * plus the audit stamp that says so (MOTIR-3215).
   *
   * ⚠️ Deliberately NOT a variant of `markSupersededByWorkItem`, even though the
   * two write the same flag. That one clears the partial-unique slot so an
   * insert can take it and is meaningless without the insert that follows;
   * this one is the whole operation. Folding them together would make the
   * `withdrawn_at` stamp an optional argument of a supersede, and the first
   * caller to forget it would record a withdrawal as a supersede — which is the
   * exact ambiguity the column was added to remove.
   *
   * Keyed by ID rather than by work item, because the service has already
   * LOCKED and READ the row it decided on: re-selecting by `WHERE is_current`
   * here would re-open the read-derived window that lock exists to close.
   */
  async withdrawById(
    id: string,
    data: { withdrawnById: string | null; withdrawnReason: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<DesignEvidenceWithAssets> {
    return tx.designEvidence.update({
      where: { id },
      data: {
        isCurrent: false,
        withdrawnAt: new Date(),
        withdrawnById: data.withdrawnById,
        withdrawnReason: data.withdrawnReason,
      },
      include: WITH_ASSETS,
    });
  },
};

/**
 * What ONE queue row needs to say WHICH design is waiting — the narrow
 * projection {@link designEvidenceRepository.findManyByIds} returns.
 *
 * `producedByKey` and `commitSha` are the two that let a reader recognise the
 * work without opening it (*the card whose pull request made this, at this
 * commit*); `noteMd` is excerpted by the caller, never rendered whole at row
 * scale; `_count.assets` is the *three files* a row shows in place of the files.
 */
const DESIGN_EVIDENCE_SUMMARY_SELECT = {
  id: true,
  workItemId: true,
  producedByKey: true,
  commitSha: true,
  noteMd: true,
  _count: { select: { assets: true } },
} as const satisfies Prisma.DesignEvidenceSelect;

/** One design result, at the size a queue row reads it. */
export type DesignEvidenceSummaryRow = Prisma.DesignEvidenceGetPayload<{
  select: typeof DESIGN_EVIDENCE_SUMMARY_SELECT;
}>;
