// DTOs for the workspace endpoints. These define EXACTLY what crosses the
// HTTP boundary — no Prisma model leaks. Add fields here when the UI needs
// them, never on raw Prisma rows in the service return type.

export interface WorkspaceDTO {
  id: string;
  name: string;
  slug: string;
  subtaskPrMergeMode: string;
}

export interface MembershipDTO {
  id: string;
  role: string;
  userId: string;
  workspaceId: string;
}

// GET /api/workspaces/current — the user's active workspace plus their
// membership in it.
export interface CurrentWorkspaceDTO {
  workspace: WorkspaceDTO;
  membership: MembershipDTO;
}
