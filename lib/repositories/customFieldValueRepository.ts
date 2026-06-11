import { Prisma, type CustomFieldValue } from '@prisma/client';
import { db } from '@/lib/db';

// Custom-field-value repository — single Prisma operations on the typed-EAV
// `custom_field_value` table (Story 5.3 · Subtask 5.3.1), the shape Jira's
// own `customfieldvalue` table uses. One row per (workItemId, fieldId) pair;
// exactly one per-type value column populated per row. The persistence leaf
// under the values half of customFieldsService (5.3.3), which owns the
// transactions, the per-type validation (the service is the authority), the
// revision-diff write that rides the same transaction, and DTO mapping.
//
// Write semantics the service builds on: a non-null set UPSERTS the pair's
// row (the @@unique([workItemId, fieldId]) is the conflict target); a clear
// DELETES the row — no tombstones, which is what makes Epic 6's "field is
// empty" compile to a clean NOT EXISTS. Reads carry an explicit
// `workspaceId` (finding #26; the column is denormalized onto this table
// precisely so the Epic-6 filter JOINs and these gates need no extra hop).
//
// This repo also owns the value-side counts the DEFINITION/OPTION flows
// read (countByField → the delete-confirm number; countByOption → the
// only-when-unused rule): the entity-name rule places a count over
// `custom_field_value` rows here, even though the callers live in the
// definitions half of the service (CLAUDE.md — repository naming matches
// the primary entity, not the call site).

/**
 * One value row with its display relations resolved — the option (label +
 * archived mark) and the user trio. What the set-value flow's current-state
 * read and the detail-rail mapper both consume.
 */
export type CustomFieldValueWithRefs = Prisma.CustomFieldValueGetPayload<{
  include: {
    valueOption: true;
    valueUser: { select: { id: true; name: true; image: true } };
  };
}>;

export const customFieldValueRepository = {
  /**
   * THE row for a (workItemId, fieldId) pair, display relations included —
   * the current-state read the set-value flow diffs against (the `from` side
   * of the `customFields.<key>` revision cell needs the OLD option's label).
   * Runs inside the set transaction (pass `tx`) so the diff it feeds is
   * computed against the row the upsert/delete replaces, under the work
   * item's FOR UPDATE lock. Served by the [workItemId, fieldId] unique.
   */
  async findByWorkItemAndField(
    workItemId: string,
    fieldId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldValueWithRefs | null> {
    const client = tx ?? db;
    return client.customFieldValue.findUnique({
      where: { workItemId_fieldId: { workItemId, fieldId } },
      include: {
        valueOption: true,
        valueUser: { select: { id: true, name: true, image: true } },
      },
    });
  },

  /**
   * Upsert THE row for a (workItemId, fieldId) pair — the single write the
   * set-value flow needs. Required `tx`: the 5.3.3 revision diff
   * (`customFields.<key>`) commits atomically with it. The service passes
   * the FULL column image (every per-type column, one non-null) in both
   * branches, so a type's previous value never survives a re-set — `update`
   * overwrites all five value columns, not just the populated one. The
   * upsert converges concurrent sets on the same pair (last write wins, no
   * duplicate-row error) via the unique conflict target.
   */
  async upsert(
    workItemId: string,
    fieldId: string,
    data: {
      workspaceId: string;
      valueText: string | null;
      valueNumber: Prisma.Decimal | number | string | null;
      valueDate: Date | null;
      valueUserId: string | null;
      valueOptionId: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<CustomFieldValue> {
    const { workspaceId, ...columns } = data;
    return tx.customFieldValue.upsert({
      where: { workItemId_fieldId: { workItemId, fieldId } },
      create: { workItemId, fieldId, workspaceId, ...columns },
      update: columns,
    });
  },

  /**
   * Clear a pair's value by DELETING its row (no tombstones). `deleteMany`,
   * not `delete`, so clearing an already-empty field is a no-op (count 0)
   * rather than a P2025 throw — the clear path is idempotent. Required
   * `tx`: the revision diff recording the clear rides the same transaction.
   */
  async deleteByWorkItemAndField(
    workItemId: string,
    fieldId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.customFieldValue.deleteMany({ where: { workItemId, fieldId } });
    return r.count;
  },

  /**
   * One issue's value rows, workspace-gated (finding #26). Bounded by the
   * 50-fields-per-project cap (an issue holds at most one row per field —
   * the unique pair), so this is the ≤50-row read `getIssueDetail` slots
   * into its parallel fetch (5.3.3) — never an unbounded read (finding
   * #57). Served by the [workItemId, fieldId] unique's leading column.
   */
  async listByWorkItem(
    workItemId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldValue[]> {
    const client = tx ?? db;
    return client.customFieldValue.findMany({
      where: { workItemId, workspaceId },
    });
  },

  /**
   * How many issues hold a value for this field — the number the
   * delete-field confirm names ("Deletes the field and its values on N
   * issues"). Run inside the delete transaction (pass `tx`) so the count
   * the user confirmed is the count the cascade destroys. Served by the
   * [fieldId, *] index family's leading column.
   */
  async countByField(
    fieldId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.customFieldValue.count({ where: { fieldId, workspaceId } });
  },

  /**
   * Per-field value counts for MANY fields in ONE query (groupBy fieldId) —
   * the admin-list read (5.3.2) names each field's value count without a
   * per-field round-trip (no N+1; the field set is ≤ the 50 cap). Fields
   * with no values are simply absent from the result (count 0 to the
   * caller). Empty-input guard: an empty id set short-circuits to [] with
   * no query.
   */
  async countGroupedByField(
    fieldIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ fieldId: string; count: number }[]> {
    if (fieldIds.length === 0) return [];
    const client = tx ?? db;
    const grouped = await client.customFieldValue.groupBy({
      by: ['fieldId'],
      where: { fieldId: { in: fieldIds }, workspaceId },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ fieldId: g.fieldId, count: g._count._all }));
  },

  /**
   * Per-option value counts for MANY options in ONE query (groupBy
   * valueOptionId) — the admin-list read (5.3.6) names each option's usage
   * ("used on N issues" / delete-when-unused affordance) without a
   * per-option round-trip (no N+1; the option set is ≤ the 55 cap per
   * field). Options with no values are absent from the result (count 0 to
   * the caller). Empty-input guard: an empty id set short-circuits to []
   * with no query. Served by [fieldId, valueOptionId]'s second column.
   */
  async countGroupedByOption(
    optionIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ optionId: string; count: number }[]> {
    if (optionIds.length === 0) return [];
    const client = tx ?? db;
    const grouped = await client.customFieldValue.groupBy({
      by: ['valueOptionId'],
      where: { valueOptionId: { in: optionIds }, workspaceId },
      _count: { _all: true },
    });
    return grouped
      .filter((g): g is typeof g & { valueOptionId: string } => g.valueOptionId !== null)
      .map((g) => ({ optionId: g.valueOptionId, count: g._count._all }));
  },

  /**
   * How many values hold this option — the only-when-unused delete rule's
   * guard read (0 → delete legal; >0 → typed OptionInUseError, archive
   * offered instead). Run inside the option-delete transaction (pass `tx`);
   * the FK's ON DELETE RESTRICT is the DB backstop if a concurrent set
   * lands between the check and the delete. Served by
   * [fieldId, valueOptionId]'s second column + the workspace gate.
   */
  async countByOption(
    optionId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.customFieldValue.count({
      where: { valueOptionId: optionId, workspaceId },
    });
  },
};
