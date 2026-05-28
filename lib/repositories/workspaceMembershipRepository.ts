import { Prisma, type Workspace, type WorkspaceMembership } from '@prisma/client';
import { db } from '@/lib/db';

// WorkspaceMembership repository — single Prisma operations on the
// `workspace_membership` join table. Owns its own file (not nested under
// workspaceRepository) because the primary entity it operates on is
// WorkspaceMembership, not Workspace.

export const workspaceMembershipRepository = {
  async findByUserAndWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembership | null> {
    return db.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
  },

  /**
   * Workspaces the user belongs to, ordered by membership.createdAt asc
   * so the auto-created default workspace (Subtask 1.2.4) lands first in
   * the switcher list (Subtask 1.2.6).
   */
  async findWorkspacesByUser(userId: string): Promise<Workspace[]> {
    const rows = await db.workspaceMembership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { workspace: true },
    });
    return rows.map((r) => r.workspace);
  },

  /**
   * Count the user's memberships inside the caller's transaction. Used by
   * ensureDefaultWorkspace as the zero-membership gate; reads inside a
   * transaction take `tx` so the count reflects rows the same transaction
   * (and the row lock it holds) can see.
   */
  async countByUser(userId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workspaceMembership.count({ where: { userId } });
  },

  /**
   * The user's first membership (by createdAt asc) inside the caller's
   * transaction — the auto-created default lands first, so this returns
   * the "active by default" workspace. Includes the workspace row so the
   * service can build its DTO without a second round-trip.
   */
  async findFirstByUserWithWorkspace(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<(WorkspaceMembership & { workspace: Workspace }) | null> {
    return tx.workspaceMembership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { workspace: true },
    });
  },

  /**
   * The user's membership in a specific workspace, with the workspace row,
   * inside the caller's transaction. Used to resolve the active context
   * for a cookie-pinned workspace.
   */
  async findByUserAndWorkspaceWithWorkspace(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<(WorkspaceMembership & { workspace: Workspace }) | null> {
    return tx.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      include: { workspace: true },
    });
  },

  async create(
    data: { userId: string; workspaceId: string; role: string },
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership> {
    return tx.workspaceMembership.create({ data });
  },

  /**
   * Returns the deleted membership row, or null if no matching row
   * existed (treats "already gone" as a no-op rather than an error —
   * the Leave / Remove flows in the settings UI rely on this).
   */
  async deleteByUserAndWorkspace(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkspaceMembership | null> {
    try {
      return await tx.workspaceMembership.delete({
        where: { userId_workspaceId: { userId, workspaceId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  },
};
