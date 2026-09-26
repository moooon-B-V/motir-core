import type { Workspace, WorkspaceMembership } from '@/generated/prisma/client';
import type { MembershipWithUser } from '@/lib/repositories/workspaceMembershipRepository';
import type { RoleMigrationReportWithPeople } from '@/lib/repositories/roleMigrationReportRepository';
import { resolveWorkspaceRole } from '@/lib/workspaces/roles';
import type {
  CurrentWorkspaceDTO,
  MembershipDTO,
  RoleMigrationBeforeDTO,
  RoleMigrationEntryDTO,
  WorkspaceDTO,
  WorkspaceMemberDTO,
  WorkspaceSummaryDTO,
} from '@/lib/dto/workspaces';

// Prisma → DTO converters for the workspace domain. The service calls these
// just before returning so no Prisma row shape leaks across the API boundary.

export function toWorkspaceDTO(workspace: Workspace): WorkspaceDTO {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
  };
}

export function toMembershipDTO(membership: WorkspaceMembership): MembershipDTO {
  return {
    id: membership.id,
    role: membership.role,
    userId: membership.userId,
    workspaceId: membership.workspaceId,
  };
}

export function toCurrentWorkspaceDTO(
  workspace: Workspace,
  membership: WorkspaceMembership,
): CurrentWorkspaceDTO {
  return {
    workspace: toWorkspaceDTO(workspace),
    membership: toMembershipDTO(membership),
  };
}

export function toWorkspaceMemberDTO(row: MembershipWithUser): WorkspaceMemberDTO {
  return {
    userId: row.user.id,
    // Fall back to the email localpart when the user has no display name
    // (OAuth users without a name claim, or pre-name-collection rows).
    name: row.user.name || row.user.email.split('@')[0]!,
    email: row.user.email,
    // Read through the deploy-window fallback, so a not-yet-migrated row still
    // reports the role it resolves to (MOTIR-6463).
    workspaceRole: resolveWorkspaceRole(row),
    customRole: row.roleDefinition
      ? { id: row.roleDefinition.id, name: row.roleDefinition.name }
      : null,
  };
}

export function toWorkspaceSummaryDTO(workspace: Workspace): WorkspaceSummaryDTO {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
  };
}

/**
 * A report row's `before_json`, read defensively. The rows are written by SQL
 * (MOTIR-6458 / MOTIR-6461) in two shapes — `{ workspaceRole, projects }` and
 * `{ narrowedIn }` — and a field the migration did not write is simply empty.
 */
function toRoleMigrationBefore(raw: unknown): RoleMigrationBeforeDTO {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    workspaceRole: str(o['workspaceRole']),
    projects: list(o['projects']).map((p) => {
      const r = (p ?? {}) as Record<string, unknown>;
      return {
        projectKey: str(r['projectKey']) ?? '',
        role: str(r['role']),
        customRoleName: str(r['customRoleName']),
      };
    }),
    narrowedIn: list(o['narrowedIn']).map((p) => {
      const r = (p ?? {}) as Record<string, unknown>;
      return {
        projectKey: str(r['projectKey']) ?? '',
        lost: list(r['lost']).filter((k): k is string => typeof k === 'string'),
      };
    }),
  };
}

export function toRoleMigrationEntryDTO(row: RoleMigrationReportWithPeople): RoleMigrationEntryDTO {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name || row.user.email.split('@')[0]!,
    email: row.user.email,
    before: toRoleMigrationBefore(row.beforeJson),
    afterRole: row.afterRole,
    afterCustomRoleName: row.afterRoleDefinition?.name ?? null,
    reason: row.reason,
  };
}
