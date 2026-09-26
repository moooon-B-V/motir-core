import {
  type MemberRole,
  Prisma,
  type ProjectMembership,
  type User,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// A project-membership row joined with the slice of its user the members list
// renders. Kept here (not in the service) because the join shape is a
// data-access concern; the service maps it to a DTO. Mirrors
// `MembershipWithUser` on workspaceMembershipRepository. It carries no role:
// a project membership means only "added to this project" since roles moved to
// the workspace (Story MOTIR-6168 · MOTIR-6464).
export type ProjectMembershipWithUser = ProjectMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

// ProjectMembership repository — single Prisma operations on the
// `project_membership` join table (Story 6.4). Owns its own file (not nested
// under projectRepository) because the primary entity is ProjectMembership,
// not Project. Writes require `tx`; reads that guard a write inside a
// transaction also take `tx` so the project_membership RLS policy (which keys
// off the per-transaction `app.workspace_id` GUC bound by withWorkspaceContext)
// admits the rows under the non-bypass motir_app role.

export const projectMembershipRepository = {
  /**
   * The user's membership in a specific project, or null. Optionally takes
   * `tx` when the caller is inside a withWorkspaceContext transaction — required
   * under the non-bypass motir_app role so the RLS policy's workspace GUC is
   * bound (outside it the policy hides every row). Used by the project-admin
   * gate and the remove path.
   */
  async findByUserAndProject(
    userId: string,
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectMembership | null> {
    const client = tx ?? dbRead;
    return client.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
    });
  },

  /**
   * The user's memberships across a SET of projects, in one query — backs the
   * browsable-projects filter (Subtask 6.4.6), which decides `canBrowse` over a
   * whole workspace's projects without an N+1 per-project round-trip. Optionally
   * takes `tx` for the same RLS-GUC reason as `findByUserAndProject`. Returns
   * only the rows that exist (a project the user has no membership in is simply
   * absent — the caller treats that as `projectRole = null`).
   */
  async findByUserAndProjects(
    userId: string,
    projectIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectMembership[]> {
    if (projectIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.projectMembership.findMany({
      where: { userId, projectId: { in: projectIds } },
    });
  },

  /**
   * One membership joined with its user slice, inside the caller's transaction.
   * Used to build the `ProjectMemberDTO` returned by add / remove without a
   * second round-trip. Same RLS-GUC requirement as findMembersByProject.
   */
  async findByUserAndProjectWithUser(
    userId: string,
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembershipWithUser | null> {
    return tx.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  },

  /**
   * Members of a project joined with the user fields the Members panel renders,
   * ordered by createdAt asc (the first-added member lands first). Takes `tx`
   * because the project_membership RLS policy reads the per-transaction
   * workspace GUC — outside the transaction the policy returns zero rows under
   * the non-bypass app role.
   */
  async findMembersByProject(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembershipWithUser[]> {
    return tx.projectMembership.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  },

  async create(
    data: { workspaceId: string; projectId: string; userId: string; role: MemberRole },
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembership> {
    return tx.projectMembership.create({ data });
  },

  /**
   * Bulk-insert memberships, skipping any (userId, projectId) that already
   * exists. Backs the go-private seeding: when a project flips to `private` we
   * add every current workspace member, and rows that already exist are left
   * alone. Returns the count created.
   */
  async createManySkipDuplicates(
    data: Array<{ workspaceId: string; projectId: string; userId: string; role: MemberRole }>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (data.length === 0) return 0;
    const result = await tx.projectMembership.createMany({ data, skipDuplicates: true });
    return result.count;
  },

  // ⚠️ NO ROLE WRITER LIVES HERE (Story MOTIR-6168 · MOTIR-6464). A project
  // membership carries no role any more — the paired-column writer and its bulk
  // reassign went with the project roles they wrote. Roles are
  // written on the WORKSPACE membership (`workspaceMembershipRepository.setWorkspaceRole`).

  /**
   * Delete a membership, returning the deleted row or null when no matching
   * row existed (treats "already gone" as an idempotent no-op, mirroring
   * workspaceMembershipRepository.deleteByUserAndWorkspace).
   */
  async deleteByUserAndProject(
    userId: string,
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectMembership | null> {
    try {
      return await tx.projectMembership.delete({
        where: { userId_projectId: { userId, projectId } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    }
  },
};
