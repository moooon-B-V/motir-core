import { Prisma, type WorkflowStatus, type WorkflowTransition } from '@prisma/client';
import { db } from '@/lib/db';

// Data access for the per-project status-workflow tables (Story 2.2 · Subtask
// 2.2.3). Single-Prisma-op leaves per CLAUDE.md — no business logic, no DTO
// mapping, no transactions. The reads on the `project` table (its
// `workflowPolicyMode`) deliberately live in `projectRepository`, NOT here:
// the entity-name rule puts a `project` read in the project repo even though
// the only caller is `workflowsService` (see that service's getWorkflow).
//
// EVERY read carries an explicit `workspaceId` in its WHERE clause (finding
// #26): RLS is the DB-layer backstop but it is INERT under the dev/CI
// superuser (BYPASSRLS), so the explicit filter is the PRIMARY tenant gate.
// A cross-workspace read (right projectId, wrong workspaceId) therefore
// returns [] / null, not another tenant's rows.
//
// Reads take an optional `tx` (mirroring `workItemRepository.findById`): a
// read-only service path passes nothing and uses the `db` singleton; a future
// validation-read-inside-a-write (2.2.4's updateStatus) can pass its `tx` so
// the lookup runs in the same transaction.

export const workflowsRepository = {
  /** A project's statuses, ordered by `position` (board-column order). */
  async findStatuses(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkflowStatus[]> {
    const client = tx ?? db;
    return client.workflowStatus.findMany({
      where: { projectId, workspaceId },
      orderBy: { position: 'asc' },
    });
  },

  /** A project's legal transitions (directed status edges). */
  async findTransitions(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkflowTransition[]> {
    const client = tx ?? db;
    return client.workflowTransition.findMany({
      where: { projectId, workspaceId },
    });
  },

  /**
   * One status by its machine-stable `key` (what `work_item.status` stores), or
   * null. `findFirst` (not the `projectId_key` unique lookup) because the
   * explicit `workspaceId` filter is part of the gate.
   */
  async findStatusByKey(
    projectId: string,
    key: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkflowStatus | null> {
    const client = tx ?? db;
    return client.workflowStatus.findFirst({
      where: { projectId, workspaceId, key },
    });
  },

  /**
   * The transition row for a directed (from → to) status pair, or null.
   * Existence is what `canTransition` checks in `restricted` mode.
   */
  async findTransition(
    projectId: string,
    fromStatusId: string,
    toStatusId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkflowTransition | null> {
    const client = tx ?? db;
    return client.workflowTransition.findFirst({
      where: { projectId, workspaceId, fromStatusId, toStatusId },
    });
  },

  // Writes (Subtask 2.2.2's seed). `tx` is REQUIRED — the seed runs inside
  // createProject's transaction so the project + its workflow are atomic. The
  // `Unchecked` create input takes the SCALAR `workspaceId`/`projectId` FKs
  // directly (not a relation `connect`): under FORCE RLS a connect's validation
  // SELECT on the parent could be hidden by the parent's own policy — the
  // scalar write avoids that, the same lesson finding #33 recorded for the
  // job-ledger writer.
  async createStatus(
    data: Prisma.WorkflowStatusUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkflowStatus> {
    return tx.workflowStatus.create({ data });
  },

  async createTransition(
    data: Prisma.WorkflowTransitionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkflowTransition> {
    return tx.workflowTransition.create({ data });
  },
};
