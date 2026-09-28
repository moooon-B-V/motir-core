import type { Project } from '@/generated/prisma/client';
import { levelForMode } from '@/lib/projects/accessMode';
import type { ProjectMembershipWithUser } from '@/lib/repositories/projectMembershipRepository';
import type { MembershipWithUser } from '@/lib/repositories/workspaceMembershipRepository';
import type {
  AccessLossPersonDTO,
  ProjectMemberDTO,
  ProjectAccessDTO,
} from '@/lib/dto/projectMembers';

// Prisma → DTO converters for the project membership + access domain. The
// service calls these just before returning so no Prisma row shape leaks
// across the API boundary.

export function toProjectMemberDTO(row: ProjectMembershipWithUser): ProjectMemberDTO {
  return {
    userId: row.user.id,
    // Fall back to the email localpart when the user has no display name
    // (OAuth users without a name claim) — mirrors toWorkspaceMemberDTO.
    name: row.user.name || row.user.email.split('@')[0]!,
    email: row.user.email,
  };
}

/** A workspace member a change of access mode would lock out (MOTIR-6544). */
export function toAccessLossPersonDTO(row: MembershipWithUser): AccessLossPersonDTO {
  return {
    userId: row.user.id,
    name: row.user.name || row.user.email.split('@')[0]!,
    email: row.user.email,
    workspaceRole: row.workspaceRole,
    customRoleName: row.roleDefinition?.name ?? null,
  };
}

export function toProjectAccessDTO(project: Project): ProjectAccessDTO {
  return {
    key: project.identifier,
    accessMode: project.accessMode,
    accessLevel: levelForMode(project.accessMode),
  };
}
