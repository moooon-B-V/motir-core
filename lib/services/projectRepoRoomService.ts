import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { githubAppInstallUrl } from '@/lib/github/appLinks';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import type { OtherHostedProjectDto, ProjectRepoRoomViewDto } from '@/lib/dto/projectRepos';

// The TAKE-IT-OVER ROOM's read model (Story MOTIR-1775 · MOTIR-1939) —
// everything `/settings/project/repositories` renders, in one server read.
//
// ⚠️ THIS SERVICE PERFORMS NO STEP OF THE SAGA. MOTIR-711 owns the transfer, the
// state machine, the webhook and the completion probe; this composes reads so the
// room can be SERVER-rendered. That split is what the card means by "the route→UI
// half only": if the surface needs something the saga does not expose, that is a
// change to MOTIR-711's API, never logic smuggled in here.
//
// ⚠️ WHY THE ORG-WIDE FACTS ARE IN A PROJECT-SCOPED READ. The billing panel's
// `Move repositories` door is ORG-scoped while a takeover is per ROW, so the room
// must carry the org truth back or an org-scoped button would silently act on one
// project and abandon the rest (design/repository-set §14.4). The paused flag
// comes from `ciAllowanceService` — the one readable owner of the entitlement
// state — rather than being re-derived, which is exactly how two surfaces come to
// disagree about whether an org is exhausted.

export const projectRepoRoomService = {
  /**
   * The room, for one project.
   *
   * Every failure of a NON-essential fact degrades to a quiet default rather than
   * failing the page: an unreadable entitlement state renders no banner, and an
   * unresolvable sibling list renders no pointers. The rows are the surface's
   * substance and are the only read allowed to throw — a room that cannot list
   * the repositories has nothing to render.
   */
  async getRoomView(projectId: string, ctx: ServiceContext): Promise<ProjectRepoRoomViewDto> {
    const [set, identity] = await Promise.all([
      projectRepoSetService.getSet(projectId, ctx),
      githubIdentityService.getIdentityForUser(ctx.userId),
    ]);

    const [ciPaused, otherHostedProjects] = await Promise.all([
      readCiPaused(ctx),
      listOtherHostedProjects(projectId, ctx),
    ]);

    return {
      projectId,
      rows: set.rows,
      hostOwner: provisioningOrgLogin(),
      githubLogin: identity?.githubLogin ?? null,
      githubAvatarUrl: identity?.avatarUrl ?? null,
      installHref: githubAppInstallUrl(),
      ciPaused,
      otherHostedProjects,
    };
  },
};

/**
 * Whether the workspace's organization is out of CI credits.
 *
 * FAILS OPEN TO "not paused", on purpose: a transport blip reading the balance
 * must not render as "you are out of credits" — the same rule
 * `ciAllowanceService` states for its own `balance: null`. A banner that
 * appears because a read failed is worse than no banner.
 */
async function readCiPaused(ctx: ServiceContext): Promise<boolean> {
  try {
    const organizationId = await withWorkspaceContext(ctx, async (tx) => {
      const workspace = await workspaceRepository.findByIdInTx(ctx.workspaceId, tx);
      return workspace?.organizationId ?? null;
    });
    if (!organizationId) return false;
    const state = await ciAllowanceService.getEntitlementState(organizationId, new Date());
    return state.state === 'ci_credits_exhausted';
  } catch {
    return false;
  }
}

/**
 * The OTHER projects in this workspace whose code Motir hosts.
 *
 * Scoped to Motir-CREATED rows (`state: 'created'`), which is the exact set the
 * banner's sentence is about — a project whose repositories the user already owns
 * is not one Motir "also hosts", and listing it would make the reassurance false.
 */
async function listOtherHostedProjects(
  projectId: string,
  ctx: ServiceContext,
): Promise<OtherHostedProjectDto[]> {
  try {
    const hostedProjectIds = await withWorkspaceContext(ctx, async (tx) => {
      const rows = await projectRepoRepository.listMotirCreatedByWorkspace(ctx.workspaceId, tx);
      return new Set(rows.map((row) => row.projectId).filter((id) => id !== projectId));
    });
    if (hostedProjectIds.size === 0) return [];

    const projects = await projectsService.listProjects(ctx.workspaceId, ctx.userId);
    return projects
      .filter((project) => hostedProjectIds.has(project.id))
      .map((project) => ({
        id: project.id,
        identifier: project.identifier,
        name: project.name,
      }));
  } catch {
    return [];
  }
}
