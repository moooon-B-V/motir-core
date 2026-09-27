import { Prisma, type ProjectAccessMode } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { isCloud } from '@/lib/billing/availability';
import {
  AlreadyProjectMemberError,
  InvalidAccessLevelError,
  InvalidAccessModeError,
  NotAProjectMemberError,
  PublicAccessUnavailableError,
  TargetNotWorkspaceMemberError,
} from '@/lib/projects/errors';
import { resolveProjectByKeyWithAliasInTx } from '@/lib/projects/resolveByKey';
import { accessModeOf, asAccessMode } from '@/lib/projects/accessMode';
import { asAccessLevel } from '@/lib/projects/roles';
import { bindOrganizationContext } from '@/lib/organizations/context';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { resolveWorkspaceRole } from '@/lib/workspaces/roles';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import {
  toAccessLossPersonDTO,
  toProjectAccessDTO,
  toProjectMemberDTO,
} from '@/lib/mappers/projectMemberMappers';
import type {
  AccessLossPersonDTO,
  ProjectAccessDTO,
  ProjectMemberDTO,
} from '@/lib/dto/projectMembers';

// projectMembersService — the write path for project membership + access
// (Story 6.4 · Subtask 6.4.4). 4-layer: this service owns the transaction, the
// validation, the project-admin gate, and the DTO mapping; the routes are thin
// HTTP transports; the single Prisma ops live in the repositories.
//
// ⚠️ A PROJECT MEMBERSHIP CARRIES NO ROLE (Story MOTIR-6168 · MOTIR-6464). Roles
// live on the workspace — one per person, the same in every project — so a row
// here means only "this person was added to this project", which is what a
// Members-only project and a Limited scope read (Story MOTIR-6169). `setRole` and the
// last-project-admin guard are gone with the project admin they protected; the
// legacy `role` column is still written (`member`, NOT NULL) until the contract
// story drops it.
//
// AUTHORIZATION — ⚠️ ONE POLICY, ASKED BY KEY (Story MOTIR-2256 · MOTIR-2295).
// Until this card, this file declared its OWN module-private `assertCanManage`
// that re-derived the admin answer from scratch (workspace-manager rail, then
// `projectMembership?.role === 'admin'`). That was a SECOND implementation of
// the access policy — it happened to agree with `lib/permissions/resolve.ts` and
// nothing kept it that way. MOTIR-2255 moved the policy into one place precisely
// so this could not happen; it is deleted, and every gate here now asks
// `projectAccessService.assertPermission` for a named key:
//
//   * `addMember` / `removeMember`              → `member:manage`
//   * `setAccessMode` / `setAccessLevel`
//     / `previewAccessModeChange`               → `project:manage_access`
//     Its own key on purpose: who is IN the project and how open the project is
//     to the workspace are different decisions, and Jira separates them too.
//   * `listMembers` / `getAccess`               → `project:browse`
//
// ⚠️ THE TWO READS ARE NOW GATED, AND THAT IS A DELIBERATE HOLE CLOSED. They
// were documented as "available to any workspace member who can resolve the
// project key". Read on this branch, `resolveProjectInTx` applies NO browse gate
// — its own header says "the access gate (assertCanBrowse) is the CALLER's job"
// — so a workspace member who could not browse a private project could still
// read its member list and its access level. `project:browse` is the right gate
// (never a `manage` key: the Members page renders READ-ONLY for non-admins by
// design, and changing what is SHOWN is MOTIR-2258's surface, not this one).
//
// Two consequences of routing through the shared gate, both intended:
//   * A NON-BROWSER now gets ProjectNotFoundError (404) where the private assert
//     returned NotProjectAdminError (403). That is the no-existence-leak posture
//     (finding #26) this file already claims below — a private project must look
//     missing, not forbidden.
//   * A browser who lacks the key gets PermissionDeniedError (403) rather than
//     NotProjectAdminError. Same status; the code changes from
//     `NOT_PROJECT_ADMIN` to `PERMISSION_DENIED`, which no consumer of these
//     routes reads (`ProjectMembersSettings` shows a generic message).
//
// RLS: every method runs inside withWorkspaceContext(ctx) so the project +
// project_membership RLS policies see the per-transaction workspace GUC under
// the non-bypass motir_app role. The project key is resolved INSIDE the same
// transaction (one service method = one transaction) so the gate read and the
// write share a snapshot.
//
// NO EXISTENCE LEAK (PRODECT_FINDINGS #26): the project is resolved by its
// workspace-scoped `identifier` — a key naming a project in ANOTHER workspace
// is indistinguishable from a non-existent one (both throw ProjectNotFoundError
// → 404), so a caller can't probe cross-tenant keys.

// Alias-aware (Story 6.8 · Subtask 6.8.2): resolves the live identifier first
// and the retired-key alias table on a miss, through the SINGLE central
// resolver, so the `/api/projects/[key]` members + access routes SERVE old keys
// identically to the live key (the verified Jira REST behaviour). `viaAlias` is
// irrelevant to a management write (the response carries the canonical project
// either way), so it's discarded here. Still no existence leak — the central
// resolver throws ProjectNotFoundError for a missing/cross-workspace/released
// key, exactly as before.
function resolveProjectInTx(key: string, ctx: WorkspaceContext, tx: Prisma.TransactionClient) {
  return resolveProjectByKeyWithAliasInTx(key, ctx.workspaceId, tx).then((r) => r.project);
}

/**
 * The actor context the shared gate takes. Built from `actorUserId` rather than
 * `ctx.userId` so the gate answers about the ACTOR the caller named — the two
 * are the same in every shipped route, and the private assert this replaces took
 * `actorUserId` explicitly, so keeping that is the behaviour-preserving reading.
 */
function actorContext(input: ActorScopedInput): { userId: string; workspaceId: string } {
  return { userId: input.actorUserId, workspaceId: input.ctx.workspaceId };
}

/**
 * Assert the actor holds `key` on the project, inside the enclosing transaction.
 * A thin adapter onto `projectAccessService.assertPermission` — `tx` is threaded
 * so the gate's reads see the per-transaction workspace GUC the RLS policies
 * need under motir_app, and share the snapshot the write will use.
 */
function assertPermission(
  input: ActorScopedInput,
  projectId: string,
  key: PermissionKey,
  tx: Prisma.TransactionClient,
): Promise<void> {
  return projectAccessService.assertPermission(projectId, actorContext(input), key, tx);
}

export interface ActorScopedInput {
  key: string;
  actorUserId: string;
  ctx: WorkspaceContext;
}

/**
 * The DECISION's level → mode mapping (`role-model.md` Q1), for the one release in
 * which the shipped UI still sends a level. `accessModeOf` carries the same table
 * for a stored row; this one maps a REQUEST.
 */
const LEVEL_TO_MODE = {
  open: 'workspace',
  limited: 'members',
  private: 'members',
  public: 'public',
} as const satisfies Record<string, ProjectAccessMode>;

export const projectMembersService = {
  /**
   * List a project's members as DTOs. BROWSE-gated (MOTIR-2295): any actor who
   * can see the project may read who is on it, and the Members UI renders that
   * read-only for non-admins — a `manage` key here would hide the page from the
   * people it is meant to inform. Before this card it was ungated, because
   * `resolveProjectInTx` resolves the key without applying the access gate, so a
   * workspace member who could not browse a private project could still read its
   * member list. Reads inside withWorkspaceContext so the project_membership RLS
   * policy exposes the rows.
   */
  async listMembers(input: ActorScopedInput): Promise<ProjectMemberDTO[]> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'project:browse', tx);
      const rows = await projectMembershipRepository.findMembersByProject(project.id, tx);
      return rows.map(toProjectMemberDTO);
    });
  },

  /**
   * Read the project's current browse-access level (open / limited / private).
   * BROWSE-gated, for the same reason as `listMembers` (MOTIR-2295): the
   * Settings → Access control pane in 6.4.5 renders it read-only for non-admins,
   * so the gate is `project:browse`, never `project:manage_access` — that key is
   * the WRITE counterpart, `setAccessLevel`.
   */
  async getAccess(input: ActorScopedInput): Promise<ProjectAccessDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'project:browse', tx);
      return toProjectAccessDTO(project);
    });
  },

  /**
   * What the project's Access & members page may OFFER this actor (Story
   * MOTIR-6169 · MOTIR-6550, design A6 / A7): the mode control needs
   * `project:manage_access`, the people controls `member:manage`. Named here, in
   * the service, because a settings page names no permission key of its own —
   * its guard reads the registry (`tests/settings/settings-destination-guard`).
   * Every write re-asserts its key regardless; these only decide what renders.
   */
  async getPageCapabilities(
    input: ActorScopedInput,
  ): Promise<{ canManageAccess: boolean; canManageMembers: boolean }> {
    const project = await withWorkspaceContext(input.ctx, (tx) =>
      resolveProjectInTx(input.key, input.ctx, tx),
    );
    const held = await projectAccessService.getPermissions(project.id, input.ctx);
    return {
      canManageAccess: held.has('project:manage_access'),
      canManageMembers: held.has('member:manage'),
    };
  },

  /**
   * Add a workspace member to the project. The target must already be a member
   * of the workspace (TargetNotWorkspaceMemberError → 400); a duplicate add
   * throws AlreadyProjectMemberError (409). `member:manage` gated. What they may
   * do here is their WORKSPACE role's — being added grants nothing of its own.
   */
  async addMember(input: ActorScopedInput & { targetUserId: string }): Promise<ProjectMemberDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'member:manage', tx);

      // The target must be a workspace member — a project can only draw from the
      // people already in its workspace (the add-member combobox in 6.4.5 is
      // scoped the same way).
      const targetWsMembership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
        input.targetUserId,
        input.ctx.workspaceId,
        tx,
      );
      if (!targetWsMembership) {
        throw new TargetNotWorkspaceMemberError(input.targetUserId, input.ctx.workspaceId);
      }

      try {
        await projectMembershipRepository.create(
          {
            workspaceId: input.ctx.workspaceId,
            projectId: project.id,
            userId: input.targetUserId,
            role: 'member',
          },
          tx,
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AlreadyProjectMemberError(input.targetUserId, project.id);
        }
        throw err;
      }

      const created = await projectMembershipRepository.findByUserAndProjectWithUser(
        input.targetUserId,
        project.id,
        tx,
      );
      // Just inserted in this tx, so it resolves — the non-null assertion is safe.
      return toProjectMemberDTO(created!);
    });
  },

  /**
   * Remove a member from the project. `member:manage` gated; 404s when the
   * target isn't a member. Returns the removed member DTO. There is no
   * last-admin guard: a project has no admin of its own to strand (MOTIR-6464).
   */
  async removeMember(
    input: ActorScopedInput & { targetUserId: string },
  ): Promise<ProjectMemberDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'member:manage', tx);

      const existing = await projectMembershipRepository.findByUserAndProjectWithUser(
        input.targetUserId,
        project.id,
        tx,
      );
      if (!existing) throw new NotAProjectMemberError(input.targetUserId, project.id);

      await projectMembershipRepository.deleteByUserAndProject(input.targetUserId, project.id, tx);
      return toProjectMemberDTO(existing);
    });
  },

  /**
   * Set the project's ACCESS MODE — Open to the workspace · Members only · Public
   * (Story MOTIR-6169 · MOTIR-6544; `role-model.md` Q1). `project:manage_access`
   * gated. Writes the mode and the legacy level TOGETHER through
   * `projectRepository.setAccessMode`, and NEVER adds anybody to the project:
   * "Members only" means the people deliberately added, so switching to it
   * removes the project from every Full member who was not, at once. (The old
   * `private` switch added every workspace member, which made it mean "everyone
   * who was here when it was flipped" — the opposite.)
   */
  async setAccessMode(input: ActorScopedInput & { mode: string }): Promise<ProjectAccessDTO> {
    const mode = asAccessMode(input.mode);
    if (!mode) throw new InvalidAccessModeError(input.mode);

    // THE PUBLISH GATE (MOTIR-4035). `public` is the one mode that publishes a
    // project to strangers, and that reading surface is a CLOUD capability
    // (Story MOTIR-3908) — off-cloud `app/api/public/*` serves nothing, so a
    // project made public there would be published into a void.
    //
    // This is the ENFORCEMENT point, not the UI: a stale client, a direct `PATCH`
    // or a script must be refused too. BEFORE the transaction and before the
    // permission assert, deliberately: the answer is a property of the BUILD,
    // identical for every caller and every key, so it needs no project read and
    // leaks nothing about one. `workspace` and `members` are how a self-hosted
    // team shares work inside its own workspace, which is what self-hosting is for.
    if (mode === 'public' && !isCloud()) throw new PublicAccessUnavailableError();

    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'project:manage_access', tx);

      // Stamp `madePublicAt` only on the transition INTO `public` (Subtask
      // 6.13.4 — the project square's Recent rank's "newest" axis). A re-save of
      // an already-public project keeps its original go-public moment.
      const stampMadePublicAt = mode === 'public' && accessModeOf(project) !== 'public';
      const updated = await projectRepository.setAccessMode(project.id, mode, tx, {
        stampMadePublicAt,
      });
      return toProjectAccessDTO(updated);
    });
  },

  /**
   * The legacy LEVEL setter, kept as a thin adapter onto {@link setAccessMode}
   * for the one release in which the shipped UI still sends `{ accessLevel }`.
   * The level is mapped by the DECISION's table — `limited` and `private` both
   * land at Members only — and validated as a level first, so a bad level keeps
   * its own error.
   */
  async setAccessLevel(input: ActorScopedInput & { level: string }): Promise<ProjectAccessDTO> {
    const level = asAccessLevel(input.level);
    if (!level) throw new InvalidAccessLevelError(input.level);
    return projectMembersService.setAccessMode({
      key: input.key,
      actorUserId: input.actorUserId,
      ctx: input.ctx,
      mode: LEVEL_TO_MODE[level],
    });
  },

  /**
   * Who would LOSE entry if the project switched to `mode` — the list the
   * Members-only confirm shows (MOTIR-6540 panel A2). Behind the same key as the
   * write, `project:manage_access`. For `members`: every Full-scope workspace
   * member who is not a Manager (the org Owner and Admins included, who read as
   * Managers) and was not added — exactly the people {@link canEnter} admits on
   * `workspace` and refuses on `members`. For any other target: nobody, because
   * `workspace` and `public` admit everyone `members` does.
   *
   * A READ, not a lock: the confirm is advisory and the write is the mode change
   * alone, so there is no read-derived write to guard.
   */
  async previewAccessModeChange(
    input: ActorScopedInput & { mode: string },
  ): Promise<AccessLossPersonDTO[]> {
    const mode = asAccessMode(input.mode);
    if (!mode) throw new InvalidAccessModeError(input.mode);

    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'project:manage_access', tx);
      if (mode !== 'members') return [];

      const [members, addedIds, workspace] = await Promise.all([
        workspaceMembershipRepository.findMembersByWorkspace(input.ctx.workspaceId, tx),
        projectMembershipRepository.findUserIdsByProject(project.id, tx),
        workspaceRepository.findByIdInTx(input.ctx.workspaceId, tx),
      ]);
      // The org's Owner and Admins are other people's org rows, admitted only
      // once the workspace's own organization is bound — a trusted resolution
      // (the workspace row just read), never request input.
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
      return members
        .filter(
          (m) =>
            m.accessScope === 'full' &&
            resolveWorkspaceRole(m) !== 'manager' &&
            !orgManagers.has(m.userId) &&
            !added.has(m.userId),
        )
        .map(toAccessLossPersonDTO);
    });
  },
};
