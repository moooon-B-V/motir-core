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
