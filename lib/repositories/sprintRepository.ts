import { Prisma, type Sprint, type SprintState } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the `sprint` table (Story 4.1 · Subtask 4.1.2). Single-
// Prisma-op leaves per CLAUDE.md — no business logic, no DTO mapping, no
// transactions. Named by its primary entity (`sprint`), not by call site.
//
// A sprint is PROJECT-scoped (see the story-4.1 module header): there is no
// `sprint.boardId`, and "one active sprint per board" resolves to one active
// sprint per PROJECT, enforced at the DB by the `sprint_one_active_per_project`
// partial-unique index (4.1.1). This repository never asserts that invariant
// itself — it just reads/writes rows; the index + the service's activation
// guard (Story 4.4) own the rule.
//
// EVERY read carries an explicit `workspaceId` in its WHERE clause (finding
// #26): the `sprint` RLS policy is the DB-layer backstop but is INERT under the
// dev/CI superuser (BYPASSRLS), so the explicit filter is the PRIMARY tenant
// gate. A cross-workspace read (right projectId, wrong workspaceId) therefore
// returns [] / null, not another tenant's rows. Mirrors `boardRepository`.
//
// Reads take an optional `tx` (mirroring `boardRepository`): a read-only path
// passes nothing and uses the `db` singleton; a validation read inside a write
// passes its `tx` so the lookup runs in the same transaction. Writes (`create`
// / `update` / `delete`) REQUIRE `tx` — a compile-time guarantee they run in a
// transaction. `findActiveByProjectForUpdate` is the lock-taking read variant
// the Story-4.4 activation flow uses to serialize concurrent activations.

export const sprintRepository = {
  /** One sprint by id, scoped to the workspace, or null. */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Sprint | null> {
    const client = tx ?? db;
    return client.sprint.findFirst({ where: { id, workspaceId } });
  },

  /**
   * The project's single `active` sprint, or null. The
   * `sprint_one_active_per_project` partial-unique index guarantees AT MOST one
   * match, so `findFirst` returns the active sprint or null when the project is
   * between sprints. Read-only path (no row lock) — the activation flow uses the
   * `FOR UPDATE` variant below.
   */
  async findActiveByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Sprint | null> {
    const client = tx ?? db;
    return client.sprint.findFirst({
      where: { projectId, workspaceId, state: 'active' },
    });
  },

  /**
   * Lock the project's `active` sprint row `FOR UPDATE` inside a transaction
   * (Story 4.4's activation/complete flows' lost-update guard). Taking this lock
   * serializes two concurrent attempts to change the active sprint in the SAME
   * project: the second blocks until the first commits, then re-reads — closing
   * the TOCTOU on the one-active-sprint invariant the partial-unique index
   * backstops. `tx` REQUIRED; the workspace filter keeps the lock tenant-scoped
   * (finding #26). Returns the locked row's id, or null when no active sprint
   * exists (the project is free to activate one). Mirrors `boardRepository.lockById`.
   */
  async findActiveByProjectForUpdate(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sprint"
        WHERE "project_id" = ${projectId} AND "workspace_id" = ${workspaceId} AND "state" = 'active'
        FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * A project's sprints, ordered by `sequence` asc (the per-project monotonic
   * ordinal — stable chronological listing; the service reorders for display if
   * a state-grouped view is wanted). Carries the explicit `workspaceId` gate.
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Sprint[]> {
    const client = tx ?? db;
    return client.sprint.findMany({
      where: { projectId, workspaceId },
      orderBy: { sequence: 'asc' },
    });
  },

  /**
   * How many sprints in a project are in a given state (e.g. the active count,
   * for the service's pre-activation check that complements the DB index).
   */
  async countByProjectAndState(
    projectId: string,
    workspaceId: string,
    state: SprintState,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    return client.sprint.count({ where: { projectId, workspaceId, state } });
  },

  /**
   * The highest `sequence` among a project's sprints, or 0 when the project has
   * none. The service adds 1 to produce the next default name ("Sprint N") and
   * the new row's sequence. Aggregate read (one Prisma op).
   */
  async maxSequenceForProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? db;
    const result = await client.sprint.aggregate({
      where: { projectId, workspaceId },
      _max: { sequence: true },
    });
    return result._max.sequence ?? 0;
  },

  /**
   * Create a sprint. `tx` REQUIRED. The `Unchecked` create input takes the
   * SCALAR `workspaceId`/`projectId` FKs directly (not a relation `connect`):
   * under FORCE RLS a connect's validation SELECT on the parent could be hidden
   * by the parent's own policy — the scalar write avoids that, the same lesson
   * `boardRepository.create` records (finding #33).
   */
  async create(
    data: Prisma.SprintUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Sprint> {
    return tx.sprint.create({ data });
  },

  /**
   * Update a sprint (rename / goal / window / state / completedAt). `tx`
   * REQUIRED; the caller (sprintsService) has already tenant-gated the sprint by
   * id + workspaceId, so this is a plain id-keyed update.
   */
  async update(
    id: string,
    data: Prisma.SprintUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<Sprint> {
    return tx.sprint.update({ where: { id }, data });
  },

  /**
   * Delete a sprint row. `tx` REQUIRED; the caller has already tenant-gated +
   * guarded the sprint (not `active`). The sprint's issues are NEVER deleted —
   * the `work_item.sprint_id` FK is `onDelete: SetNull`, so they fall back to
   * the backlog in their existing `backlogRank` order (schema, 4.1.1).
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<Sprint> {
    return tx.sprint.delete({ where: { id } });
  },
};
