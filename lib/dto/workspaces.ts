// DTOs for the workspace endpoints + settings surfaces. These define
// EXACTLY what crosses the HTTP / Server-Action boundary — no Prisma
// model leaks. Add fields here when the UI needs them, never on raw
// Prisma rows in a service return type.

// ── GET /api/workspaces/current (Subtask 1.2.4) ──
export interface WorkspaceDTO {
  id: string;
  name: string;
  slug: string;
}

export interface MembershipDTO {
  id: string;
  role: string;
  userId: string;
  workspaceId: string;
}

// The user's active workspace plus their membership in it.
export interface CurrentWorkspaceDTO {
  workspace: WorkspaceDTO;
  membership: MembershipDTO;
}

// ── Settings surfaces (Subtask 1.2.6) ──
export interface WorkspaceMemberDTO {
  userId: string;
  name: string;
  email: string;
  role: string;
}

export interface WorkspaceSummaryDTO {
  id: string;
  name: string;
  slug: string;
}

/**
 * One row of the org Workspaces section (MOTIR-6309): a workspace in the
 * organization with the two counts the section shows. `projectCount` includes
 * archived projects — it is the count removal REACHES (the same number the
 * remove confirmation states), not the count a picker would offer.
 */
export interface OrgWorkspaceRowDTO {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  projectCount: number;
  createdAt: string;
}

/** One keyset page of {@link OrgWorkspaceRowDTO}s. */
export interface OrgWorkspacePageDTO {
  workspaces: OrgWorkspaceRowDTO[];
  nextCursor: string | null;
  total: number;
}
