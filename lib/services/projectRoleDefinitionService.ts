import type { Prisma } from '@/generated/prisma/client';
import { projectRoleDefinitionRepository } from '@/lib/repositories/projectRoleDefinitionRepository';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { isEnforced, type PermissionKey } from '@/lib/permissions/catalog';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { toRoleCatalogDTO } from '@/lib/mappers/permissionMappers';
import type { RoleCatalogDTO } from '@/lib/dto/permissions';

// projectRoleDefinitionService — what is LEFT of the project custom roles (Story
// MOTIR-2257), which retired as role grants in Story MOTIR-6168 (MOTIR-6464):
// roles live on the workspace, and a custom role is authored there
// (`workspaceRoleDefinitionService`). Creating, editing, deleting and assigning a
// PROJECT role went with the routes that called them, which answer 410.
//
// Two things remain, both until the project Roles pages move to the workspace
// (MOTIR-6466), which deletes this file:
//   * `grantablePermissionKeys` — the rule for what ANY role may hold, which the
//     workspace roles service reuses;
//   * `getRoleCatalog` — the read those pages still render.

/**
 * The set a role may draw from: role-gated AND `enforced`.
 *
 * ⚠️ DERIVED FROM THE CONSTANTS, never a literal list. The `enforcement` marker
 * exists precisely so a key no gate consults can never become a switch that
 * controls nothing — a settings screen showing such a switch is a promise the
 * code does not keep, and it is the failure this whole epic was built to remove.
 * `PLANNED_PERMISSIONS` is empty on `origin/main` today, so this refuses nothing
 * in practice; it is written this way so the NEXT planned key is refused with no
 * code change. A level-gated `public_request:*` key is refused by the same
 * expression, for the same reason: no role can hold one.
 *
 * Computed lazily rather than at module load so a test can add a synthetic
 * non-enforced key and see the check follow it.
 */
export function grantablePermissionKeys(
  roleGated: readonly PermissionKey[] = ROLE_GATED_PERMISSIONS,
  enforced: (key: PermissionKey) => boolean = isEnforced,
): ReadonlySet<PermissionKey> {
  return new Set(roleGated.filter((key) => enforced(key)));
}

export const projectRoleDefinitionService = {
  /**
   * The project's ROLE CATALOG (moved here from `projectAccessService` by
   * MOTIR-6459, which took every project-role read out of the access service —
   * the resolver no longer reads a project role at all; this catalogue serves
   * the project Roles page until MOTIR-6466 moves that page to the workspace) — every role with the permissions it holds and how
   * many people hold it, plus the ROLE-GATED permission rows grouped by domain
   * and their total. This is what the read-only Roles & permissions screens
   * render (Subtask MOTIR-2263), list and detail alike.
   *
   * ⚠️ A PROJECT-SCOPED SERVICE READ, not a static import, even though today's
   * PERMISSION answer is the same for every project. Story MOTIR-2257 makes
   * custom roles project-scoped, at which point that half genuinely depends on
   * which project is asked — and a page wired to a constant would need its data
   * source torn out and replaced exactly then. The member counts are already
   * per-project. It also re-uses the same 404-not-403 gate, so the page cannot
   * confirm a foreign project exists.
   *
   * ⚠️ THE GATE RUNS BEFORE THE READ. `resolveInputs` throws
   * ProjectNotFoundError for a project in another workspace, so a cross-tenant id
   * never reaches a role read at all.
   */
  async getRoleCatalog(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<RoleCatalogDTO> {
    // Resolves for its SIDE EFFECT — the ProjectNotFoundError guard, which runs
    // BEFORE any read so a foreign project's roles are never returned OR
    // counted. This is the card MOTIR-2439's note pointed at: the read was built
    // project-scoped precisely so the day a project has roles of its own,
    // nothing about its shape had to change.
    await projectAccessService.getPermissions(projectId, ctx, tx);

    // Only the role ROWS are read. The holder counts went with the project roles
    // (Story MOTIR-6168 · MOTIR-6464): a project membership holds no role, so
    // every role here is held by nobody at this tier, and the workspace's own
    // Roles page is where a role's holders are counted. The rows are read under
    // the workspace context their RLS policy needs.
    const read = (t: Prisma.TransactionClient) =>
      projectRoleDefinitionRepository.findManyByProject(projectId, t);
    const customRoles = tx
      ? await read(tx)
      : await withWorkspaceContext(
          { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
          read,
        );

    return toRoleCatalogDTO({}, customRoles, {});
  },
};
