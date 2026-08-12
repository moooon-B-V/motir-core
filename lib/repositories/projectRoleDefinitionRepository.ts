import { type Prisma, type ProjectRoleDefinition } from '@/generated/prisma/client';

// ProjectRoleDefinition repository — single Prisma operations on the
// `project_role_definition` table (Story MOTIR-2257 · Subtask MOTIR-2467). The
// persistence leaf for a project's OWN roles, under
// projectRoleDefinitionService (MOTIR-2472), which owns the transactions, the
// per-project cap, the permission-set validation and the delete-with-reassign.
//
// NO VALIDATION LIVES HERE. Not of the permission values, not of the name, not
// of the count — a repository that validates is a second policy implementation,
// and the whole point of putting every rule in one service is that a route, a
// page and a future API client all get the same answers.
//
// NO ERROR TRANSLATION EITHER. A duplicate `(projectId, name)` insert raises
// P2002 and this layer lets it through untouched; the SERVICE catches it and
// rethrows the typed RoleNameTakenError. Same posture as
// customFieldOptionRepository, whose in-use P2003 is likewise the service's to
// name. (The DB is the backstop, not the messenger.)
//
// RLS: `project_role_definition` carries its own `workspace_id` and a FOR ALL
// policy keyed on the per-transaction `app.workspace_id` GUC that
// withWorkspaceContext binds. Outside a workspace-context transaction the
// non-bypass `motir_app` role sees zero rows.
//
// So every read here REQUIRES `tx`, exactly as the writes do (MOTIR-2755). It
// used to be optional with a `tx ?? db` fallback; that arm returned an empty
// result under `motir_app` and RAISED NOTHING, which is the silent-empty failure
// this whole cutover exists to remove — and it was unreachable in practice, since
// every caller already binds. A branch that cannot be honestly exercised in both
// role modes (the bound answer and the unbound answer differ, so no assertion is
// true of both) is a branch that should not exist.

export const projectRoleDefinitionRepository = {
  /**
   * Every custom role a project has defined, ordered by name so the catalog's
   * order is a property of the READ rather than a sort re-done in a component
   * (MOTIR-2478's deterministic ordering rests on this). Requires `tx` for the
   * RLS-GUC reason above.
   */
  async findManyByProject(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRoleDefinition[]> {
    return tx.projectRoleDefinition.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
  },

  /**
   * One role definition by id, or null. Used by the resolution arm
   * (MOTIR-2470) to read the set a membership points at, and by the service to
   * check that a role exists — and belongs to the project it claims — before
   * writing. Takes `tx` when the caller is inside the transaction that will
   * write, so the read and the write share one snapshot and one workspace GUC.
   */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<ProjectRoleDefinition | null> {
    return tx.projectRoleDefinition.findUnique({ where: { id } });
  },

  /**
   * Several role definitions by id in ONE query. Backs a resolution that has
   * more than one membership in hand without an N+1; also the shape a future
   * batch read wants. Returns only the rows that exist.
   */
  async findManyByIds(
    ids: string[],
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRoleDefinition[]> {
    if (ids.length === 0) return [];
    return tx.projectRoleDefinition.findMany({ where: { id: { in: ids } } });
  },

  /**
   * How many custom roles the project already has. REQUIRES `tx`: its only
   * caller is the service's cap guard, which is a count-then-create and
   * therefore a race unless the count and the insert share a transaction with
   * the project row locked. Making `tx` mandatory is what stops someone
   * calling it outside one and re-introducing that race.
   */
  async countByProject(projectId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.projectRoleDefinition.count({ where: { projectId } });
  },

  /**
   * Insert one role definition. The unchecked input carries `workspaceId` /
   * `projectId` as scalars — the workspace column is denormalized precisely so
   * the RLS policy can gate on it directly, and `WITH CHECK` rejects a row
   * naming a foreign workspace.
   */
  async create(
    data: Prisma.ProjectRoleDefinitionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRoleDefinition> {
    return tx.projectRoleDefinition.create({ data });
  },

  /**
   * Patch one role definition (rename → `name`; re-permission → `permissions`).
   * Which patches are legal — and that `basedOn` is never among them, because
   * provenance is recorded once at creation and never re-written — is the
   * service's call.
   */
  async update(
    id: string,
    patch: Prisma.ProjectRoleDefinitionUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectRoleDefinition> {
    return tx.projectRoleDefinition.update({ where: { id }, data: patch });
  },

  /**
   * Delete one role definition. Legal ONLY when no membership points at it —
   * the service counts holders first and reassigns them in the SAME
   * transaction. The membership FK's `ON DELETE RESTRICT` rejects anything that
   * slips past (P2003), which is the backstop rather than the messenger.
   */
  async delete(id: string, tx: Prisma.TransactionClient): Promise<ProjectRoleDefinition> {
    return tx.projectRoleDefinition.delete({ where: { id } });
  },
};
