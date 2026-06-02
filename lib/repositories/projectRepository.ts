import { Prisma, type Project, type WorkflowPolicyMode } from '@prisma/client';
import { db } from '@/lib/db';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Project repository — single Prisma operations on the `project` table.
// Writes require `tx` (compile-time guarantee they run in a transaction);
// pure read paths use the `db` singleton. No business logic, no DTO
// mapping, no transactions here — those belong in projectsService.

export const projectRepository = {
  /**
   * Read a project by id. Optionally takes `tx` when the caller is already
   * inside a transaction — required when running under the non-bypass
   * prodect_app role with the project RLS policy in force, because the
   * policy keys on the per-transaction `app.workspace_id` GUC that
   * withWorkspaceContext binds. Outside withWorkspaceContext the policy
   * sees NULL and hides every row under the non-bypass role.
   */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<Project | null> {
    const client = tx ?? db;
    return client.project.findUnique({ where: { id } });
  },

  async findBySlug(workspaceId: string, slug: string): Promise<Project | null> {
    return db.project.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
  },

  /**
   * Non-archived projects in a workspace, ordered by createdAt asc so the
   * first-created project lands first in any list surface. Optionally takes
   * `tx` so the read happens inside withWorkspaceContext when the caller
   * needs the project RLS policy to see the workspace GUC (production
   * non-bypass role); outside a tx this falls back to the `db` singleton,
   * which is fine for the BYPASSRLS dev/CI role.
   */
  async findByWorkspace(workspaceId: string, tx?: Prisma.TransactionClient): Promise<Project[]> {
    const client = tx ?? db;
    return client.project.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  },

  async create(
    data: { workspaceId: string; name: string; slug: string; identifier: string },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.create({ data });
  },

  async update(
    id: string,
    data: { name?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Soft-delete: stamp archivedAt = now(). Projects are NEVER hard-deleted
   * — work-item history (Story 1.4) must survive an archive.
   */
  async archive(id: string, tx: Prisma.TransactionClient): Promise<Project> {
    return tx.project.update({ where: { id }, data: { archivedAt: new Date() } });
  },

  /** Flip the project's workflow policy mode (Subtask 2.2.5). */
  async updateWorkflowPolicyMode(
    id: string,
    mode: WorkflowPolicyMode,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { workflowPolicyMode: mode } });
  },

  /**
   * Atomically bump the per-project work-item counter and return the new
   * value. Uses UPDATE … RETURNING (NOT a read-then-write) so allocation is
   * gap-free under concurrency: each concurrent caller's UPDATE serializes
   * on the row, and the RETURNING value is the post-increment number. The
   * counter is per-project (the WHERE clause keys on id) so two projects
   * never share or interfere with each other's numbering.
   */
  async allocateWorkItemNumber(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ n: number }>>`
      UPDATE "project" SET "lastWorkItemNumber" = "lastWorkItemNumber" + 1
      WHERE "id" = ${id} RETURNING "lastWorkItemNumber" AS n`;
    if (rows.length === 0) throw new ProjectNotFoundError(id);
    return Number(rows[0]!.n);
  },
};
