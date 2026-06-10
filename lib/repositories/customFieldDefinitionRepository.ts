import { Prisma, type CustomFieldDefinition } from '@prisma/client';
import { db } from '@/lib/db';

// Custom-field-definition repository — single Prisma operations on the
// `custom_field_definition` table (Story 5.3 · Subtask 5.3.1). The
// persistence leaf under customFieldsService (5.3.2), which owns the
// transactions, the 50-fields-per-project cap, the immutable-`key` rule,
// the project-admin gate, and DTO mapping.
//
// Layer rules (CLAUDE.md): writes REQUIRE `tx` (a definition write always
// rides a transaction — create seeds initial options for `select` fields and
// the cap check must guard the insert it gates; delete cascades option +
// value rows). Reads carry an explicit `workspaceId` in the WHERE clause
// (finding #26): RLS is the DB-layer backstop but it is INERT under the
// dev/CI superuser (BYPASSRLS), so the explicit filter is the PRIMARY tenant
// gate — a cross-workspace read returns [] / null, not another tenant's
// rows. Reads take an optional `tx` so a validation-read-inside-a-write
// (5.3.2's cap check) can run in the same transaction.
//
// No error translation: the table has no triggers; a cross-workspace write
// attempt is caught by the RLS policy's WITH CHECK (42501) for non-bypass
// roles, and the service's own admin gate is the application-layer guard.

export const customFieldDefinitionRepository = {
  /**
   * Insert one field definition. Required `tx` — the create rides the same
   * transaction as its cap-guard read and (for `select` fields) its seeded
   * option rows (5.3.2). Unchecked input: the service already holds the
   * scalar FKs (`workspaceId` / `projectId`).
   */
  async create(
    data: Prisma.CustomFieldDefinitionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CustomFieldDefinition> {
    return tx.customFieldDefinition.create({ data });
  },

  /**
   * Patch one definition (rename → `label`; reorder → `position`). `key` is
   * immutable after create — the SERVICE enforces that by never passing it;
   * this leaf executes whatever patch it is handed (single-op rule).
   */
  async update(
    id: string,
    patch: Prisma.CustomFieldDefinitionUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CustomFieldDefinition> {
    return tx.customFieldDefinition.update({ where: { id }, data: patch });
  },

  /**
   * HARD-delete one definition — the verified team-managed semantics
   * (immediate, permanent, no trash). The DB cascades take the option rows
   * and every stored value with it; the service reads the value count first
   * so the UI confirm can name it (customFieldValueRepository.countByField).
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<CustomFieldDefinition> {
    return tx.customFieldDefinition.delete({ where: { id } });
  },

  /**
   * One definition by id, workspace-gated (finding #26) — `findFirst`, not
   * the bare-id unique lookup, because the explicit `workspaceId` filter is
   * part of the gate. Null for unknown ids AND for cross-workspace probes
   * (the service maps both to 404, finding #44).
   */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldDefinition | null> {
    const client = tx ?? db;
    return client.customFieldDefinition.findFirst({ where: { id, workspaceId } });
  },

  /**
   * A project's field definitions in `position` order (the admin list and
   * the detail-rail read both consume this order). Bounded by the 50-field
   * cap the service enforces — never an unbounded read (finding #57).
   * Backed by the (project_id, position) index.
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<CustomFieldDefinition[]> {
    const client = tx ?? db;
    return client.customFieldDefinition.findMany({
      where: { projectId, workspaceId },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * How many fields the project already has — the 50-cap guard read. Runs
   * inside the create transaction (pass `tx`) so a concurrent create can't
   * slip past the cap unobserved.
   */
  async countByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.customFieldDefinition.count({ where: { projectId, workspaceId } });
  },
};
