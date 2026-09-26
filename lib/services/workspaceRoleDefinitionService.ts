import { Prisma, type WorkspaceRole } from '@/generated/prisma/client';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workspaceRoleDefinitionRepository } from '@/lib/repositories/workspaceRoleDefinitionRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { readReachRole } from '@/lib/workspaces/membershipGate';
import {
  CUSTOM_WORKSPACE_ROLE_TIER,
  WORKSPACE_ROLES,
  resolveWorkspaceRole,
} from '@/lib/workspaces/roles';
import {
  NotAMemberError,
  WorkspaceRoleForbiddenError,
  WorkspaceRoleInUseError,
  WorkspaceRoleNameTakenError,
} from '@/lib/workspaces/errors';
import { isPermissionKey, type PermissionKey } from '@/lib/permissions/catalog';
import { WORKSPACE_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { MAX_ROLE_NAME_LENGTH } from '@/lib/permissions/limits';
import {
  BuiltInRoleImmutableError,
  InvalidRoleNameError,
  InvalidRoleReassignTargetError,
  RoleDefinitionNotFoundError,
  UngrantablePermissionError,
} from '@/lib/permissions/errors';
import { grantablePermissionKeys } from '@/lib/services/projectRoleDefinitionService';
import { toWorkspaceRoleCatalogDTO, toWorkspaceRoleDTO } from '@/lib/mappers/workspaceRoleMappers';
import type { WorkspaceRoleCatalogDTO, WorkspaceRoleDTO } from '@/lib/dto/workspaceRoles';

// workspaceRoleDefinitionService — a workspace's OWN roles (Story MOTIR-6168 ·
// MOTIR-6460). The workspace-tier home of what `projectRoleDefinitionService`
// did for a project: create, edit and delete-with-reassign, with the shipped
// semantics carried over rather than rewritten — the name bound, the write-time
// refusal of a key no role may hold, the not-found posture for a foreign role,
// and a delete that moves every holder and removes the role in ONE transaction.
//
// ⚠️ THE ACTOR GATE IS A ROLE, NOT A KEY. Every write asserts the actor is a
// MANAGER of the workspace — their workspace role, or the org Owner composed in
// through `readReachRole` (MOTIR-6308). A custom role carries project-scope keys
// only, so no custom role can author roles, and there is no key to grant that
// would let one. Reading the catalog is open to every member, because the Roles
// pages are readable by all.
//
// Every read and write runs under `withWorkspaceContext` bound to the NAMED
// workspace: `workspace_role_definition` and `workspace_membership` are both
// RLS-gated on `app.workspace_id`.

/** The built-in role names, which are code rather than rows. */
const BUILT_IN_NAMES = new Set<string>([...WORKSPACE_ROLES, 'owner', 'admin']);

interface Actor {
  userId: string;
}

/** Trim + bound a name, or throw — the project service's rule, unchanged. */
function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidRoleNameError();
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_ROLE_NAME_LENGTH) throw new InvalidRoleNameError();
  return name;
}

/** Validate a key list against the grantable set, or throw naming the offender. */
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

function asBase(raw: unknown): WorkspaceRole {
  if (raw === 'manager' || raw === 'member' || raw === 'viewer') return raw;
  throw new InvalidRoleReassignTargetError();
}

/** Translate the `(workspace_id, name)` unique's P2002 into the typed error. */
function asNameTaken(err: unknown, name: string): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new WorkspaceRoleNameTakenError(name);
  }
  throw err;
}

/**
 * The actor's reach into the workspace: not a member → NotAMemberError (404, a
 * workspace they cannot see stays indistinguishable from a missing one); a member
 * who is not a Manager → WorkspaceRoleForbiddenError (403) when `requireManager`.
 */
async function assertActor(
  actor: Actor,
  workspaceId: string,
  requireManager: boolean,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const role = await readReachRole(actor.userId, workspaceId, tx);
  if (role == null) throw new NotAMemberError(actor.userId, workspaceId);
  if (requireManager && role !== 'manager') {
    throw new WorkspaceRoleForbiddenError(actor.userId, workspaceId);
  }
}

/** A role that belongs to THIS workspace, or not-found — never a cross-tenant write. */
async function requireOwnRole(roleId: string, workspaceId: string, tx: Prisma.TransactionClient) {
  if (BUILT_IN_NAMES.has(roleId)) throw new BuiltInRoleImmutableError(roleId);
  const role = await workspaceRoleDefinitionRepository.findById(roleId, tx);
  if (!role || role.workspaceId !== workspaceId) throw new RoleDefinitionNotFoundError(roleId);
  return role;
}

export interface CreateWorkspaceRoleInput {
  workspaceId: string;
  name: unknown;
  /**
   * The built-in the author STARTS FROM. It seeds the key set and is not stored
   * — a role IS its name and its set (the `based_on` decision, 2026-08-09).
   */
  basedOn: unknown;
  /**
   * The keys to hold. When present they are the role's set exactly (the editor
   * sends what the author composed); when absent the base's set is taken as is.
   */
  permissions?: unknown;
}

export interface UpdateWorkspaceRoleInput {
  workspaceId: string;
  roleId: string;
  name?: unknown;
  permissions?: unknown;
}

export interface DeleteWorkspaceRoleInput {
  workspaceId: string;
  roleId: string;
  /** Move holders to a built-in (`manager` / `member` / `viewer`)… */
  reassignToRole?: WorkspaceRole | string | null;
  /** …or to another custom role of this workspace. */
  reassignToDefinitionId?: string | null;
}

export const workspaceRoleDefinitionService = {
  /**
   * The workspace's role catalog — the three built-ins and every custom role,
   * each with its holder count. Readable by every member of the workspace.
   */
  async listForWorkspace(workspaceId: string, actor: Actor): Promise<WorkspaceRoleCatalogDTO> {
    return withWorkspaceContext({ userId: actor.userId, workspaceId }, async (tx) => {
      await assertActor(actor, workspaceId, false, tx);
      const [builtInRows, customRoles] = await Promise.all([
        workspaceMembershipRepository.countBuiltInRolesByWorkspace(workspaceId, tx),
        workspaceRoleDefinitionRepository.findManyByWorkspace(workspaceId, tx),
      ]);
      const customCounts = await workspaceRoleDefinitionRepository.countHolders(
        customRoles.map((r) => r.id),
        tx,
      );
      const builtInCounts: Partial<Record<WorkspaceRole, number>> = {};
      for (const row of builtInRows) {
        const key = resolveWorkspaceRole(row);
        builtInCounts[key] = (builtInCounts[key] ?? 0) + row.count;
      }
      return toWorkspaceRoleCatalogDTO(workspaceId, builtInCounts, customRoles, customCounts);
    });
  },

  /** Author a new workspace role from a Manager, Member or Viewer base. Manager-only. */
  async create(input: CreateWorkspaceRoleInput, actor: Actor): Promise<WorkspaceRoleDTO> {
    const name = normalizeName(input.name);
    const base = asBase(input.basedOn);
    const permissions =
      input.permissions === undefined
        ? normalizePermissions([...WORKSPACE_ROLE_PERMISSIONS[base]])
        : normalizePermissions(input.permissions);

    return withWorkspaceContext(
      { userId: actor.userId, workspaceId: input.workspaceId },
      async (tx) => {
        await assertActor(actor, input.workspaceId, true, tx);
        try {
          const row = await workspaceRoleDefinitionRepository.create(
            { workspaceId: input.workspaceId, name, permissions },
            tx,
          );
          return toWorkspaceRoleDTO(row, 0);
        } catch (err) {
          asNameTaken(err, name);
        }
      },
    );
  },

  /** Rename a role and/or replace its key set — one call, as the editor saves both. */
  async update(input: UpdateWorkspaceRoleInput, actor: Actor): Promise<WorkspaceRoleDTO> {
    const patch: { name?: string; permissions?: PermissionKey[] } = {};
    if (input.name !== undefined) patch.name = normalizeName(input.name);
    if (input.permissions !== undefined)
      patch.permissions = normalizePermissions(input.permissions);

    return withWorkspaceContext(
      { userId: actor.userId, workspaceId: input.workspaceId },
      async (tx) => {
        await assertActor(actor, input.workspaceId, true, tx);
        const role = await requireOwnRole(input.roleId, input.workspaceId, tx);
        try {
          const row = await workspaceRoleDefinitionRepository.update(role.id, patch, tx);
          const counts = await workspaceRoleDefinitionRepository.countHolders([row.id], tx);
          return toWorkspaceRoleDTO(row, counts.get(row.id) ?? 0);
        } catch (err) {
          asNameTaken(err, patch.name ?? role.name);
        }
      },
    );
  },

  /**
   * Delete a role, with the reassignment as part of the definition of done:
   *   * nobody holds it → delete;
   *   * somebody does and no destination was given → WorkspaceRoleInUseError
   *     carrying the COUNT, and nothing is written;
   *   * a destination was given → every holder moves through `setWorkspaceRole`
   *     (the columns' one writer) THEN the role is deleted, in ONE transaction.
   * The `Restrict` foreign key is the backstop, not the messenger.
   */
  async delete(input: DeleteWorkspaceRoleInput, actor: Actor): Promise<void> {
    await withWorkspaceContext(
      { userId: actor.userId, workspaceId: input.workspaceId },
      async (tx) => {
        await assertActor(actor, input.workspaceId, true, tx);
        const role = await requireOwnRole(input.roleId, input.workspaceId, tx);
        const holders = await workspaceMembershipRepository.findByRoleDefinition(role.id, tx);
        const wantsMove = Boolean(input.reassignToRole || input.reassignToDefinitionId);

        if (holders.length > 0 && !wantsMove) {
          throw new WorkspaceRoleInUseError(role.name, holders.length);
        }
        if (wantsMove) {
          const destination = await resolveDestination(input, role.id, tx);
          for (const holder of holders) {
            await workspaceMembershipRepository.setWorkspaceRole(
              holder.userId,
              input.workspaceId,
              destination,
              tx,
            );
          }
        }
        await workspaceRoleDefinitionRepository.delete(role.id, tx);
      },
    );
  },
};

/**
 * Resolve a delete's destination to the paired columns, refusing BEFORE any
 * write. Legal: one of the three built-ins, or ANOTHER custom role of the same
 * workspace. Everything else is one error — from the caller's side it is one
 * mistake, and distinguishing them would leak whether a foreign role id exists.
 */
async function resolveDestination(
  input: DeleteWorkspaceRoleInput,
  deletingId: string,
  tx: Prisma.TransactionClient,
): Promise<{ workspaceRole: WorkspaceRole; roleDefinitionId: string | null }> {
  if (input.reassignToDefinitionId) {
    if (input.reassignToDefinitionId === deletingId) throw new InvalidRoleReassignTargetError();
    const target = await workspaceRoleDefinitionRepository.findById(
      input.reassignToDefinitionId,
      tx,
    );
    if (!target || target.workspaceId !== input.workspaceId) {
      throw new InvalidRoleReassignTargetError();
    }
    return { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: target.id };
  }
  return { workspaceRole: asBase(input.reassignToRole), roleDefinitionId: null };
}
