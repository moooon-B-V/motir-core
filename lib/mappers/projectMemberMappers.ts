import type { Project } from '@/generated/prisma/client';
import type { ProjectMembershipWithUser } from '@/lib/repositories/projectMembershipRepository';
import type { ProjectMemberDTO, ProjectAccessDTO } from '@/lib/dto/projectMembers';
import type { ProjectRole } from '@/lib/projects/roles';

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
    // The stored value is the shared MemberRole enum; a project membership only
    // ever holds an assignable project role (admin/member/viewer) — the service
    // never writes `owner` here — so the narrowing is sound.
    role: row.role as ProjectRole,
    // The joined custom role, narrowed to what a member row renders (MOTIR-2485).
    // `null` here IS the "built-in" answer — there is no second boolean to drift
    // out of step with it.
    roleDefinition: row.roleDefinition
      ? { id: row.roleDefinition.id, name: row.roleDefinition.name }
      : null,
  };
}

export function toProjectAccessDTO(project: Project): ProjectAccessDTO {
  return {
    key: project.identifier,
    accessLevel: project.accessLevel,
  };
}
