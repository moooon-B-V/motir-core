import type { Workspace, WorkspaceMembership } from '@prisma/client';
import type { CurrentWorkspaceDTO, MembershipDTO, WorkspaceDTO } from '@/lib/dto/workspaces';

// Prisma → DTO converters for the workspace domain. The service calls these
// just before returning so no Prisma row shape leaks across the API boundary.

export function toWorkspaceDTO(workspace: Workspace): WorkspaceDTO {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    subtaskPrMergeMode: workspace.subtaskPrMergeMode,
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
