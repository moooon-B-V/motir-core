import { Prisma, type ProjectKeyAlias } from '@prisma/client';
import { db } from '@/lib/db';

// Project-key-alias repository — single Prisma operations on the
// `project_key_alias` table (Story 6.8 · Subtask 6.8.1). A row records a
// RETIRED project key so it keeps resolving (old links 308-redirect, REST
// serves) and stays reserved against other projects. Writes require `tx`
// (compile-time guarantee they run in a transaction — every alias write is part
// of the rename / release transaction); reads used inside the rename's collision
// guard take `tx` so they share the FOR-UPDATE snapshot, while the pure
// previous-keys listing can use the `db` singleton. No business logic, no DTO
// mapping, no transactions here — those belong in projectsService.

export const projectKeyAliasRepository = {
  /**
   * Read the alias row reserving `identifier` in a workspace, or null. Keyed on
   * the `@@unique([workspaceId, identifier])` compound — the SAME namespace
   * `project.identifier` is unique within — so the rename collision guard checks
   * live identifiers and aliases against one key space. Takes `tx`: it is the
   * guarding read for the rename write (and the create-path reservation check),
   * so it must run inside the enclosing transaction (and, under the non-bypass
   * prodect_app role, see the RLS workspace GUC).
   */
  async findByWorkspaceAndIdentifier(
    workspaceId: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectKeyAlias | null> {
    return tx.projectKeyAlias.findUnique({
      where: { workspaceId_identifier: { workspaceId, identifier } },
    });
  },

  /**
   * The retired keys of a project, newest first (the details card's "Previous
   * keys" list). Pure read path → `db` singleton; optionally takes `tx` when a
   * caller wants it inside a transaction's snapshot.
   */
  async findManyByProject(
    projectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProjectKeyAlias[]> {
    const client = tx ?? db;
    return client.projectKeyAlias.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Reserve a retired key for a project. Write → `tx` required. */
  async create(
    data: { workspaceId: string; projectId: string; identifier: string },
    tx: Prisma.TransactionClient,
  ): Promise<ProjectKeyAlias> {
    return tx.projectKeyAlias.create({ data });
  },

  /**
   * Delete the alias row reserving `identifier` in a workspace, returning the
   * row count. Backs the RECLAIM path (changing a project's key back to its own
   * previous key removes that alias so the key becomes live again). Write → `tx`
   * required.
   */
  async deleteByWorkspaceAndIdentifier(
    workspaceId: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.projectKeyAlias.deleteMany({ where: { workspaceId, identifier } });
    return r.count;
  },

  /**
   * Delete one project's alias by identifier, returning the row count. Backs the
   * RELEASE path (the "Previous project keys" remove): scoping the delete to
   * `projectId` means a caller can only release an alias that belongs to the
   * project they resolved, and the count lets the service distinguish a real
   * release (1) from a no-such-alias request (0 → typed 404). Write → `tx`
   * required.
   */
  async deleteByProjectAndIdentifier(
    projectId: string,
    identifier: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.projectKeyAlias.deleteMany({ where: { projectId, identifier } });
    return r.count;
  },
};
