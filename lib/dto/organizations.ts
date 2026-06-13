// DTOs for the organization endpoints + org-admin surfaces (Story 6.10). These
// define EXACTLY what crosses the HTTP / Server-Action boundary — no Prisma
// model leaks. The org-admin UI (6.10.5) consumes these.

export interface OrganizationDTO {
  id: string;
  name: string;
  slug: string;
}

// A workspace the member belongs to within the org, for the cross-workspace
// roster's "which workspaces" column (6.10.5 panel 3).
export interface OrgMemberWorkspaceDTO {
  id: string;
  name: string;
}

// One row of the cross-workspace member roster: a person in the org, their
// org-scoped role, and the org's workspaces they're a member of.
export interface OrgMemberDTO {
  userId: string;
  name: string;
  email: string;
  role: string;
  workspaces: OrgMemberWorkspaceDTO[];
}

// A page of the cross-workspace member roster — keyset-paginated (the at-scale
// rule, finding #57): a large org has hundreds of members across many
// workspaces, so the roster is NEVER loaded whole. `nextCursor` is the
// membership id to pass as `cursor` for the next page, or null at the end.
export interface OrgMemberPageDTO {
  members: OrgMemberDTO[];
  nextCursor: string | null;
  total: number;
}

// The active org plus the signed-in user's org-scoped role in it (for the shell
// org control + the org-admin gate in 6.10.5).
export interface CurrentOrganizationDTO {
  organization: OrganizationDTO;
  role: string;
}
