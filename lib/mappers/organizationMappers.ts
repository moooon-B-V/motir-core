import type { Organization } from '@prisma/client';
import type { OrgMembershipWithUser } from '@/lib/repositories/organizationMembershipRepository';
import type {
  CurrentOrganizationDTO,
  OrganizationDTO,
  OrgMemberDTO,
  OrgMemberWorkspaceDTO,
} from '@/lib/dto/organizations';

// Prisma → DTO converters for the organizations domain (Story 6.10). The
// service calls these just before returning so no Prisma row shape leaks across
// the API boundary. Mirrors lib/mappers/workspaceMappers.ts.

export function toOrganizationDTO(org: Organization): OrganizationDTO {
  return { id: org.id, name: org.name, slug: org.slug };
}

export function toCurrentOrganizationDTO(org: Organization, role: string): CurrentOrganizationDTO {
  return { organization: toOrganizationDTO(org), role };
}

/**
 * Build a roster row from a membership-with-user join plus the member's
 * workspace memberships within the org (resolved by the service). Falls back to
 * the email localpart when the user has no display name (OAuth users without a
 * name claim), mirroring toWorkspaceMemberDTO.
 */
export function toOrgMemberDTO(
  row: OrgMembershipWithUser,
  workspaces: OrgMemberWorkspaceDTO[],
): OrgMemberDTO {
  return {
    userId: row.user.id,
    name: row.user.name || row.user.email.split('@')[0]!,
    email: row.user.email,
    role: row.role,
    workspaces,
  };
}
