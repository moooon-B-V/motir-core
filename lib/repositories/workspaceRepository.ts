import { Prisma, type Workspace } from '@prisma/client';
import { db } from '@/lib/db';

// Workspace repository — single Prisma operations on the `workspace` table.
// Membership operations live in workspaceMembershipRepository — the
// primary entity is `WorkspaceMembership`, not `Workspace`, even though
// the workspace is the parent.

export const workspaceRepository = {
  async findById(id: string): Promise<Workspace | null> {
    return db.workspace.findUnique({ where: { id } });
  },

  async findBySlug(slug: string): Promise<Workspace | null> {
    return db.workspace.findUnique({ where: { slug } });
  },

  /**
   * Same lookup as findById, but inside the caller's transaction so the
   * workspace RLS policy (which keys off the per-transaction app.workspace_id /
   * app.user_id GUCs) admits the row under the non-bypass prodect_app role.
   * Used by the Story 6.10 org access gate to resolve a workspace's
   * organizationId inside the bound context; the db-singleton variant returns
   * NULL under RLS when no context is bound.
   */
  async findByIdInTx(id: string, tx: Prisma.TransactionClient): Promise<Workspace | null> {
    return tx.workspace.findUnique({ where: { id } });
  },

  /**
   * Every workspace under an organization, ordered by createdAt asc. Takes `tx`
   * because the workspace RLS policy reads the per-transaction GUCs. Used by the
   * Story 6.10 cross-workspace member-roster enrichment and the org-admin
   * workspace span (an org owner/admin's access reaches every workspace under
   * the org).
   */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Workspace[]> {
    return tx.workspace.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  },

  async create(
    // Story 6.10: a workspace is non-nullably nested under an Organization, so
    // organizationId is required here. The service creates/resolves the org and
    // passes its id (see workspacesService.insertWorkspaceWithOwner).
    data: { name: string; slug: string; organizationId: string },
    tx: Prisma.TransactionClient,
  ): Promise<Workspace> {
    return tx.workspace.create({ data });
  },

  async update(
    id: string,
    data: { name: string },
    tx: Prisma.TransactionClient,
  ): Promise<Workspace> {
    return tx.workspace.update({ where: { id }, data });
  },

  async delete(id: string, tx: Prisma.TransactionClient): Promise<Workspace> {
    return tx.workspace.delete({ where: { id } });
  },
};
