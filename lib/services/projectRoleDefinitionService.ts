import { Prisma, type ProjectRoleDefinition } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectRoleDefinitionRepository } from '@/lib/repositories/projectRoleDefinitionRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { resolveProjectByKeyWithAliasInTx } from '@/lib/projects/resolveByKey';
import { isEnforced, isPermissionKey, type PermissionKey } from '@/lib/permissions/catalog';
import { CUSTOM_ROLE_TIER, ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { asProjectRole, type ProjectRole } from '@/lib/projects/roles';
import { MAX_CUSTOM_ROLES_PER_PROJECT, MAX_ROLE_NAME_LENGTH } from '@/lib/permissions/limits';
import {
  BuiltInRoleImmutableError,
  InvalidRoleNameError,
  InvalidRoleReassignTargetError,
  RoleDefinitionNotFoundError,
  RoleInUseError,
  RoleLimitReachedError,
  RoleNameTakenError,
  UngrantablePermissionError,
} from '@/lib/permissions/errors';
import { toRoleDefinitionDTO } from '@/lib/mappers/permissionMappers';
import type { RoleDefinitionDTO } from '@/lib/dto/permissions';

// projectRoleDefinitionService — EVERY rule about what a custom role may be
// (Story MOTIR-2257 · Subtask MOTIR-2472), in ONE place, so no route and no
// component re-implements a policy. A role editor is a form, and a form will
// happily post anything; the question of what a role is allowed to BE has to be
// answered somewhere a form cannot go around.
//
// Owns the transactions and the DTO mapping. The repositories underneath are
// single-op leaves; the routes above (MOTIR-2474) are HTTP-only.
//
// ⚠️ THE GATE IS `project:manage_access`, not a new catalog key. A role
// definition IS project access, and that key is the one `projectMembersService`
// already gates add-member and set-role on — this story adds no catalog key
// (the catalog is MOTIR-2255's, and this story only lets a role CHOOSE among
// keys that already exist).
//
// ⚠️ NO EXTERNAL SIDE EFFECT RUNS INSIDE A TRANSACTION. There are none in this
// service, and none may be added inside one.

/** The three built-in role names, which are code rather than rows. */
const BUILT_IN_NAMES = new Set<string>(['admin', 'member', 'viewer', 'owner']);

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

/** Trim + bound a name, or throw. */
function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidRoleNameError();
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_ROLE_NAME_LENGTH) throw new InvalidRoleNameError();
  return name;
}

/** Validate a permission list against the grantable set, or throw naming the offender. */
function normalizePermissions(raw: unknown): PermissionKey[] {
  if (!Array.isArray(raw)) throw new UngrantablePermissionError(String(raw));
  const grantable = grantablePermissionKeys();
  const out = new Set<PermissionKey>();
  for (const key of raw) {
    if (typeof key !== 'string' || !isPermissionKey(key) || !grantable.has(key)) {
      throw new UngrantablePermissionError(String(key));
    }
    out.add(key);
  }
  return [...out];
}

/**
 * Refuse an operation aimed at a built-in. Runs on the UNTRUSTED identifier
 * string before anything else touches it, so `PATCH /roles/admin` is a refusal
 * rather than a not-found.
 */
function assertNotBuiltIn(roleId: string): void {
  if (BUILT_IN_NAMES.has(roleId)) throw new BuiltInRoleImmutableError(roleId);
}

/** Translate the `(project_id, name)` unique's P2002 into the typed error. */
function asNameTaken(err: unknown, name: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new RoleNameTakenError(name);
  }
  throw err;
}

/**
 * Read a role definition and prove it belongs to `projectId`. A role from
 * ANOTHER project resolves to not-found rather than a cross-project write — the
 * same no-existence-leak posture the project gate takes.
 */
async function requireOwnRole(
  roleId: string,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<ProjectRoleDefinition> {
  const role = await projectRoleDefinitionRepository.findById(roleId, tx);
  if (!role || role.projectId !== projectId) throw new RoleDefinitionNotFoundError(roleId);
  return role;
}

export interface CreateRoleInput {
  projectId: string;
  ctx: AccessActorContext;
  name: unknown;
  /**
   * The permission set the role holds. The editor SEEDS this grid from a
   * built-in the author picks ("Start from"), but that pick is an authoring
   * convenience and is NOT sent, NOT stored and NOT rendered — what arrives here
   * is the set the author actually composed.
   */
  permissions: unknown;
}

export interface UpdateRoleInput {
  projectId: string;
  roleId: string;
  ctx: AccessActorContext;
  /** Absent leaves the name alone; present is validated and applied. */
  name?: unknown;
  /** Absent leaves the set alone; present is validated and applied. */
  permissions?: unknown;
}

export interface DeleteRoleInput {
  projectId: string;
  roleId: string;
  ctx: AccessActorContext;
  /**
   * Where the role's members move to. A custom role's id, or one of `admin` /
   * `member` / `viewer`. Absent means "tell me how many are affected" — the
   * refusal the confirmation dialog reads before it asks.
   */
  reassignTo?: string | null;
}

export const projectRoleDefinitionService = {
  /**
   * Resolve a project `[key]` segment to its id (Story MOTIR-2257 · Subtask
   * MOTIR-2474). A SERVER COMPONENT already holds the id (`getActiveProject`);
   * an HTTP route holds the key, and resolving one is a READ the service owns
   * rather than logic a route may carry.
   *
   * Routes through the ONE alias-aware resolver every key-addressed read funnels
   * through, so a RETIRED key keeps working here exactly as it does on the
   * members routes — and a key naming a project in another workspace raises
   * `ProjectNotFoundError` (404), with no existence leak.
   */
  async resolveProjectIdByKey(key: string, ctx: AccessActorContext): Promise<string> {
    return withWorkspaceContext(ctx, async (tx) => {
      const { project } = await resolveProjectByKeyWithAliasInTx(key, ctx.workspaceId, tx);
      return project.id;
    });
  },

  /** One of the project's own roles, by id. Gated on `project:manage_access`. */
  async findById(
    projectId: string,
    roleId: string,
    ctx: AccessActorContext,
  ): Promise<RoleDefinitionDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'project:manage_access');
    return withWorkspaceContext(ctx, async (tx) =>
      toRoleDefinitionDTO(await requireOwnRole(roleId, projectId, tx)),
    );
  },

  /**
   * Author a new role.
   *
   * ⚠️ THE CAP IS A COUNT-THEN-CREATE, SO IT LOCKS. A plain read-then-write
   * races: two admins clicking `Create role` at the same moment both read `n`
   * and both insert, and the project ends up over its cap. So the project row is
   * taken `FOR UPDATE` first (the lock-before-a-read-derived-write rule), the
   * count is read INSIDE that lock, and the insert follows — which serializes
   * the pair rather than merely narrowing the window.
   */
  async create(input: CreateRoleInput): Promise<RoleDefinitionDTO> {
    await projectAccessService.assertPermission(
      input.projectId,
      input.ctx,
      'project:manage_access',
    );
    const name = normalizeName(input.name);
    const permissions = normalizePermissions(input.permissions);

    return withWorkspaceContext(input.ctx, async (tx) => {
      const locked = await projectRepository.lockById(input.projectId, tx);
      /* istanbul ignore next -- defensive: assertPermission already resolved the project in this workspace; it can only be missing here if a concurrent tx deleted it in the window */
      if (!locked) throw new ProjectNotFoundError(input.projectId);

      const existing = await projectRoleDefinitionRepository.countByProject(input.projectId, tx);
      if (existing >= MAX_CUSTOM_ROLES_PER_PROJECT) {
        throw new RoleLimitReachedError(MAX_CUSTOM_ROLES_PER_PROJECT);
      }

      try {
        return toRoleDefinitionDTO(
          await projectRoleDefinitionRepository.create(
            {
              workspaceId: input.ctx.workspaceId,
              projectId: input.projectId,
              name,
              permissions,
            },
            tx,
          ),
        );
      } catch (err) {
        asNameTaken(err, name);
      }
    });
  },

  /**
   * Rename a role and/or replace its permission set — one call, because the
   * editor saves both at once. There is nothing else to patch: a role IS its
   * name and its set.
   */
  async update(input: UpdateRoleInput): Promise<RoleDefinitionDTO> {
    assertNotBuiltIn(input.roleId);
    await projectAccessService.assertPermission(
      input.projectId,
      input.ctx,
      'project:manage_access',
    );
    const patch: { name?: string; permissions?: PermissionKey[] } = {};
    if (input.name !== undefined) patch.name = normalizeName(input.name);
    if (input.permissions !== undefined)
      patch.permissions = normalizePermissions(input.permissions);

    return withWorkspaceContext(input.ctx, async (tx) => {
      const role = await requireOwnRole(input.roleId, input.projectId, tx);
      try {
        return toRoleDefinitionDTO(
          await projectRoleDefinitionRepository.update(role.id, patch, tx),
        );
      } catch (err) {
        asNameTaken(err, patch.name ?? role.name);
      }
    });
  },

  /** Rename only — the thin wrapper the editor's inline rename calls. */
  async rename(args: {
    projectId: string;
    roleId: string;
    ctx: AccessActorContext;
    name: unknown;
  }): Promise<RoleDefinitionDTO> {
    return this.update({ ...args, name: args.name });
  },

  /** Replace the permission set only. */
  async setPermissions(args: {
    projectId: string;
    roleId: string;
    ctx: AccessActorContext;
    permissions: unknown;
  }): Promise<RoleDefinitionDTO> {
    return this.update({ ...args, permissions: args.permissions });
  },

  /**
   * Delete a role — with the reassignment, which is not a refinement but part of
   * the definition of done.
   *
   *   * nobody holds it → delete;
   *   * somebody holds it and no destination was given → `RoleInUseError`
   *     carrying the COUNT, and NOTHING is written. That number is the cue the
   *     confirmation dialog reads to name how many people are affected;
   *   * a destination was given → reassign THEN delete, in ONE transaction, so
   *     the two can never half-happen.
   *
   * The `Restrict` FK underneath is the backstop, not a substitute: it refuses a
   * delete that slipped past this, but it cannot ask where the members go.
   */
  async delete(input: DeleteRoleInput): Promise<void> {
    assertNotBuiltIn(input.roleId);
    await projectAccessService.assertPermission(
      input.projectId,
      input.ctx,
      'project:manage_access',
    );

    await withWorkspaceContext(input.ctx, async (tx) => {
      const role = await requireOwnRole(input.roleId, input.projectId, tx);

      const counts = await projectMembershipRepository.countByRoleDefinition(input.projectId, tx);
      const holders = counts.find((c) => c.roleDefinitionId === role.id)?.count ?? 0;

      if (holders > 0) {
        if (!input.reassignTo) throw new RoleInUseError(role.name, holders);
        const destination = await resolveDestination(input, role, tx);
        await projectMembershipRepository.reassignRoleDefinition(role.id, destination, tx);
      } else if (input.reassignTo) {
        // A destination on an unheld role still has to be a legal one — a caller
        // that names a foreign project's role should be refused rather than
        // silently ignored.
        await resolveDestination(input, role, tx);
      }

      await projectRoleDefinitionRepository.delete(role.id, tx);
    });
  },
};

/**
 * Resolve `reassignTo` to the paired columns a membership write needs, refusing
 * BEFORE any write. Legal destinations: one of the three built-ins, or ANOTHER
 * role belonging to the SAME project. The role being deleted, a role in another
 * project, and anything unrecognised are all `InvalidRoleReassignTargetError` —
 * one error, because from the caller's side they are one mistake, and
 * distinguishing them would leak whether a foreign role id exists.
 */
async function resolveDestination(
  input: DeleteRoleInput,
  role: ProjectRoleDefinition,
  tx: Prisma.TransactionClient,
): Promise<{ roleDefinitionId: string | null; role: ProjectRole }> {
  const target = input.reassignTo;
  /* istanbul ignore next -- callers reach this only inside a `if (input.reassignTo)` branch */
  if (!target) throw new InvalidRoleReassignTargetError();

  const builtIn = asProjectRole(target);
  if (builtIn) return { roleDefinitionId: null, role: builtIn };

  if (target === role.id) throw new InvalidRoleReassignTargetError();
  const destination = await projectRoleDefinitionRepository.findById(target, tx);
  if (!destination || destination.projectId !== input.projectId) {
    throw new InvalidRoleReassignTargetError();
  }
  // Every custom role sits at the same tier, so moving between two of them
  // never changes `role` — the pair is still written together so the invariant
  // holds through one writer.
  return { roleDefinitionId: destination.id, role: CUSTOM_ROLE_TIER };
}
