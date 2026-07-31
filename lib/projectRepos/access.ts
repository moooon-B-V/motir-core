import type { ProjectRepo, ProjectRepoState } from '@prisma/client';
import type { ProjectRepoAccessDto, ProjectRepoAccessStateDto } from '@/lib/dto/projectRepos';

// COLLABORATOR ACCESS — the derivation, in one module (Story MOTIR-1775 ·
// MOTIR-1900).
//
// A repository Motir creates lives in Motir's own org and is private, so the
// person who approved the plan cannot clone it until Motir invites their GitHub
// account. The persisted record of that invitation is two timestamps plus the
// login and URL (`project_repository.collaborator_*`); the STATE the UI renders
// is derived from them here, so no consumer re-implements the rule and the DTO,
// the service and the tests cannot disagree about what "invited" means.
//
// WHY DERIVED RATHER THAN STORED — see the migration: a stored state has to be
// cleared by whatever set it, so a crash between the GitHub call and the write
// leaves it lying. Two stamps recompute the same answer on every read.

/** Every access state, in the order the design's table lists them. Exported as a
 *  value so a totality test can assert the union and this list stay in lockstep. */
export const PROJECT_REPO_ACCESS_STATES = [
  'not_invited',
  'invited',
  'accepted',
] as const satisfies readonly ProjectRepoAccessStateDto[];

/** The persisted half of a row this module reads — accepted as a structural type
 *  so a caller may pass a full Prisma row, a locked re-read, or a fixture. */
export type ProjectRepoAccessColumns = Pick<
  ProjectRepo,
  | 'collaboratorLogin'
  | 'collaboratorInvitedAt'
  | 'collaboratorAcceptedAt'
  | 'collaboratorInvitationUrl'
>;

/**
 * The row's access STATE.
 *
 * Order is the whole rule: `accepted` outranks `invited`, because a row that was
 * invited and then accepted is not still pending — and accepting deliberately
 * does NOT clear `collaboratorInvitedAt` (the row keeps both events), so reading
 * the stamps in the other order would report every accepted invitation as
 * outstanding forever.
 */
export function deriveAccessState(row: ProjectRepoAccessColumns): ProjectRepoAccessStateDto {
  if (row.collaboratorAcceptedAt !== null) return 'accepted';
  if (row.collaboratorInvitedAt !== null) return 'invited';
  return 'not_invited';
}

/** The whole access half of a row's DTO. */
export function toAccessDto(row: ProjectRepoAccessColumns): ProjectRepoAccessDto {
  const state = deriveAccessState(row);
  return {
    state,
    login: row.collaboratorLogin,
    // Only a PENDING invitation has somewhere to open. Once accepted the URL
    // leads to an invitation that no longer exists, so it is not offered — the
    // design gives `accepted` no forward path for exactly this reason.
    invitationUrl: state === 'invited' ? row.collaboratorInvitationUrl : null,
  };
}

/**
 * Is this row one that NEEDS a collaborator invitation?
 *
 * `created` ONLY, and that is not an oversight. `created` is reachable solely
 * through `proposed → creating → created` (`lib/projectRepos/transitions.ts`), so
 * it is exactly the set of repositories MOTIR made and owns — the ones the user
 * has no access to. A `connected` row is a repository the user ALREADY owns and
 * granted Motir; inviting them to their own repository is at best a no-op and at
 * worst a confusing invitation from a stranger. The design draws the invitation
 * line on `created` rows for the same reason.
 */
export function needsCollaboratorInvite(state: ProjectRepoState): boolean {
  return state === 'created';
}
