import {
  Prisma,
  type EstimationStatistic,
  type PointScale,
  type Project,
  type ProjectAccessLevel,
  type WorkflowPolicyMode,
} from '@prisma/client';
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
   * Read a project by its workspace-unique `identifier` (the `PROD`-style key
   * that prefixes work-item keys). Backs `projectsService.getByKey` — the
   * `?projectKey=` resolution the agent-dispatch endpoints (7.0.4 / 7.0.5)
   * use. Keyed on the `@@unique([workspaceId, identifier])` compound, so the
   * lookup is inherently workspace-scoped: a project living in another
   * workspace is simply not found (the no-existence-leak contract is enforced
   * one layer up, in the service). Optionally takes `tx` so the read sees the
   * project RLS policy's workspace GUC under the non-bypass prodect_app role,
   * exactly like `findById`.
   */
  async findByIdentifier(
    workspaceId: string,
    identifier: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Project | null> {
    const client = tx ?? db;
    return client.project.findUnique({
      where: { workspaceId_identifier: { workspaceId, identifier } },
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

  /**
   * Acquire a row-level lock on the project inside the caller's transaction —
   * the guarding read for the key-change flow (Story 6.8 · projectsService
   * `changeKey`): lock the row, then run the collision guards + the bulk
   * identifier rewrite + the alias insert, all serialized against a concurrent
   * rename OR a concurrent `allocateWorkItemNumber`-backed issue creation on the
   * same project (the lock-before-read-derived-update rule). Without it two
   * renames could each read the pre-change identifier and clobber each other,
   * or an issue could be minted with the stale prefix mid-rewrite. Returns null
   * when the id doesn't exist. Mirrors workItemRepository.lockById /
   * userRepository.lockById.
   */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "project" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async update(
    id: string,
    data: { name?: string; avatarIcon?: string | null; avatarColor?: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
  },

  /**
   * Set the project's `identifier` (the "key") — the project-row half of the
   * key-change transaction (Story 6.8). The work-item identifier rewrite is the
   * separate bulk op `workItemRepository.rewriteIdentifiersForProject`, and the
   * old key is recorded by `projectKeyAliasRepository.create`; the service
   * orchestrates all three plus the FOR-UPDATE lock in one transaction.
   */
  async updateIdentifier(
    id: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { identifier } });
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

  /** Set the project's browse-access level (Story 6.4 · Subtask 6.4.4). */
  async setAccessLevel(
    id: string,
    accessLevel: ProjectAccessLevel,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { accessLevel } });
  },

  /**
   * Set the project's public Overview/README Markdown body (Story 6.12 ·
   * Subtask 6.12.8). `null` clears it (the public Overview tab then falls back
   * to the slim auto-intro, 6.12.4). A public-safe field that rides the public
   * projection only when the project is `public`.
   */
  async setPublicOverview(
    id: string,
    publicOverviewMd: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data: { publicOverviewMd } });
  },

  // --- Estimation config (Story 4.3 · Subtask 4.3.3) ------------------------
  // The project-scoped estimation settings (`estimationStatistic` / `pointScale`
  // / `customScaleValues`; see the story-4.3 module header for the
  // project-scoped justified deviation). Single Prisma ops; the read is a
  // projection (the roll-up only needs the statistic) used by the read-only
  // roll-up paths, so it takes no `tx`; the update REQUIRES `tx`.

  /**
   * Read just a project's estimation config columns (the projection the roll-up
   * statistic resolution + the settings read need). Returns null when the
   * project doesn't exist — the caller (estimationService) owns the tenant gate
   * + the not-found error. Read-only path → `db` singleton.
   */
  async findEstimationConfig(
    id: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    estimationStatistic: EstimationStatistic;
    pointScale: PointScale;
    customScaleValues: number[];
  } | null> {
    const client = tx ?? db;
    return client.project.findUnique({
      where: { id },
      select: { estimationStatistic: true, pointScale: true, customScaleValues: true },
    });
  },

  /**
   * Update a project's estimation config (any subset of the three fields). `tx`
   * REQUIRED; the caller (estimationService) has already tenant-gated +
   * admin-gated the project, so this is a plain id-keyed update.
   */
  async updateEstimationConfig(
    id: string,
    data: {
      estimationStatistic?: EstimationStatistic;
      pointScale?: PointScale;
      customScaleValues?: number[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<Project> {
    return tx.project.update({ where: { id }, data });
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
