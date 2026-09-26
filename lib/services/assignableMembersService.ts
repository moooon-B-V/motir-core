import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { toWorkspaceMemberDTO } from '@/lib/mappers/workspaceMappers';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// assignableMembersService — the set of people the assignee / reporter pickers
// may offer for a project (Story 6.4 · Subtask 6.4.6). It mirrors Jira: on a
// `private` project, assignable users are scoped to the PROJECT's members (you
// can't assign work to someone who can't see the project); on `open` / `limited`
// projects, the whole workspace is assignable (every workspace member can browse
// it). One chokepoint so every picker-feeding surface (the issue list, the issue
// detail / edit forms, the board peek) scopes identically — the page reads this
// instead of `workspacesService.listMembers` for a project-scoped view.
//
// Returns the same `WorkspaceMemberDTO` shape the pickers already consume, so the
// AssigneePicker component is unchanged: the `private` branch keeps the project's
// members, in the project's order, and reports each one's WORKSPACE row — a
// person's role is their workspace role in every project (Story MOTIR-6168).

export const assignableMembersService = {
  /**
   * The members assignable on a project, scoped by its access level:
   *   * `open` / `limited` → every workspace member (they can all browse it).
   *   * `private`          → only the project's members.
   * The caller passes the access level it already resolved on the project DTO
   * (no extra round-trip); the read runs inside `withWorkspaceContext` so the
   * `project_membership` RLS policy exposes the rows.
   */
  async list(input: {
    projectId: string;
    // `public` (Story 6.12) scopes like `open`/`limited` here — the `!== 'private'`
    // branch lists every workspace member (the internal authoring pickers; a
    // public project's PUBLIC view hides assignees entirely, 6.12.4).
    accessLevel: 'open' | 'limited' | 'private' | 'public';
    ctx: WorkspaceContext;
  }): Promise<WorkspaceMemberDTO[]> {
    if (input.accessLevel !== 'private') {
      return workspacesService.listMembers(input.ctx.workspaceId, input.ctx.userId);
    }
    return withWorkspaceContext(input.ctx, async (tx) => {
      const rows = await projectMembershipRepository.findMembersByProject(input.projectId, tx);
      const workspaceRows = await workspaceMembershipRepository.findMembersByWorkspace(
        input.ctx.workspaceId,
        tx,
      );
      const byUser = new Map(workspaceRows.map((m) => [m.userId, m]));
      // A project member always holds a workspace membership (the membership
      // cascade removes one with the other), so a miss is skipped, never invented.
      return rows.flatMap((row) => {
        const m = byUser.get(row.userId);
        return m ? [toWorkspaceMemberDTO(m)] : [];
      });
    });
  },
};
