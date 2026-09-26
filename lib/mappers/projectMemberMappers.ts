import type { Project } from '@/generated/prisma/client';
import type { ProjectMembershipWithUser } from '@/lib/repositories/projectMembershipRepository';
import type { ProjectMemberDTO, ProjectAccessDTO } from '@/lib/dto/projectMembers';

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

export function toProjectAccessDTO(project: Project): ProjectAccessDTO {
  return {
    key: project.identifier,
    accessLevel: project.accessLevel,
  };
}
