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
    data: { name: string; slug: string },
    tx: Prisma.TransactionClient,
  ): Promise<Workspace> {
    return tx.workspace.create({ data });
  },
};
