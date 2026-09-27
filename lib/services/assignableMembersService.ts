import type { ProjectAccessMode } from '@/generated/prisma/client';
import { canEnter } from '@/lib/permissions/resolve';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { toWorkspaceMemberDTO } from '@/lib/mappers/workspaceMappers';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { toPersonLabel, type PersonLabel } from '@/lib/people/personLabel';
import { VISITOR_ACTOR_ID, type VisitorReadContext } from '@/lib/visitor/context';

// assignableMembersService — the set of people the assignee / reporter pickers,
// the mention gates and every other "who can be in this project?" question may
// offer for a project (Story 6.4 · Subtask 6.4.6; Story MOTIR-6169 · MOTIR-6547).
// It mirrors Jira: you can't assign work to, or mention, someone who can't open
// the project. One chokepoint so every picker-feeding surface (the issue list, the
// issue detail / edit forms, the board peek, the mention validators, a component's
// default assignee, a user custom field, team code access) scopes identically.
//
// ⚠️ THE ANSWER IS THE ENTRY RULE, NOT A COPY OF IT. A member is offered exactly
// when `canEnter` (`lib/permissions/resolve.ts`) admits them: a Manager (the org
// Owner and Admins included), anyone ADDED, and a Full-scope member on a
// `workspace` / `public` project. A contractor with a Limited scope is never
// offered on a project they cannot open, and a Full member is never offered on a
// Members-only project they were not added to.
//
// Returns the same `WorkspaceMemberDTO` shape the pickers already consume — a
// person's role is their workspace role in every project (Story MOTIR-6168).

export const assignableMembersService = {
  /**
   * The workspace members who can ENTER the project, in the workspace's own
   * order. The caller passes the mode it already resolved on the project (no
   * extra round-trip for it); the membership, "was added" and org-manager reads
   * run in ONE `withWorkspaceContext` so the RLS policies expose the rows.
   */
  async list(input: {
    projectId: string;
    accessMode: ProjectAccessMode;
    ctx: WorkspaceContext;
  }): Promise<WorkspaceMemberDTO[]> {
    return (await enteringMembers(input)).map(toWorkspaceMemberDTO);
  },

  /**
   * The same people, NAME ONLY, for a Visitor (Story MOTIR-6170 · MOTIR-6646) —
   * the lookup behind the assignee column, the board cards and the quick view.
   * No email and no email local part: a person with no name reads as the
   * neutral label ({@link toPersonLabel}).
   */
  async listPersonLabels(ctx: VisitorReadContext): Promise<PersonLabel[]> {
    const rows = await enteringMembers({
      projectId: ctx.project.id,
      accessMode: 'public',
      ctx: { userId: VISITOR_ACTOR_ID, workspaceId: ctx.project.workspaceId },
    });
    return rows.map((row) => toPersonLabel(row.user));
  },
};

/**
 * The workspace members who can ENTER the project, in the workspace's own order,
 * as membership rows — {@link assignableMembersService.list} maps them to the
 * member DTO, {@link assignableMembersService.listPersonLabels} to names only.
 */
async function enteringMembers(input: {
  projectId: string;
  accessMode: ProjectAccessMode;
  ctx: WorkspaceContext;
}) {
  return withWorkspaceContext(input.ctx, async (tx) => {
    const [members, addedIds, workspace] = await Promise.all([
      workspaceMembershipRepository.findMembersByWorkspace(input.ctx.workspaceId, tx),
      projectMembershipRepository.findUserIdsByProject(input.projectId, tx),
      workspaceRepository.findByIdInTx(input.ctx.workspaceId, tx),
    ]);
    let orgManagers = new Set<string>();
    if (workspace) {
      await bindOrganizationContext(tx, workspace.organizationId);
      orgManagers = new Set(
        await organizationMembershipRepository.findManagerUserIdsByOrganization(
          workspace.organizationId,
          tx,
        ),
      );
    }
    const added = new Set(addedIds);
    return members.filter((m) =>
      canEnter({
        accessMode: input.accessMode,
        workspaceRole: orgManagers.has(m.userId) ? 'manager' : m.workspaceRole,
        accessScope: m.accessScope,
        addedToProject: added.has(m.userId),
      }),
    );
  });
}
