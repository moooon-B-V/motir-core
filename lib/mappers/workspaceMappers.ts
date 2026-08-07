import type { Workspace, WorkspaceMembership } from '@/generated/prisma/client';
import type { MembershipWithUser } from '@/lib/repositories/workspaceMembershipRepository';
import type {
  CurrentWorkspaceDTO,
  MembershipDTO,
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

export function toWorkspaceMemberDTO(row: MembershipWithUser): WorkspaceMemberDTO {
  return {
    userId: row.user.id,
    // Fall back to the email localpart when the user has no display name
    // (OAuth users without a name claim, or pre-name-collection rows).
    name: row.user.name || row.user.email.split('@')[0]!,
    email: row.user.email,
    role: row.role,
  };
}

export function toWorkspaceSummaryDTO(workspace: Workspace): WorkspaceSummaryDTO {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
  };
}
