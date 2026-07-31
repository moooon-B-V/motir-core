import type { ProjectRepoCollaborator, ProjectRepoState } from '@prisma/client';
import type {
  ProjectRepoAccessDto,
  ProjectRepoAccessStateDto,
  ProjectRepoCollaboratorPermissionDto,
  ProjectRepoMemberAccessReasonDto,
} from '@/lib/dto/projectRepos';

// COLLABORATOR ACCESS — the derivation, in one module (Story MOTIR-1775 ·
// MOTIR-1900, generalised to the whole team by MOTIR-1910).
//
// A repository Motir creates lives in Motir's own org and is private, so nobody
// on the team can clone it until Motir invites their GitHub account. The
// persisted record of that invitation is one `project_repository_collaborator`
// row per `(repository, user)` — two timestamps plus the login, the permission
// and the invitation URL. The STATE the UI renders is derived from them here, so
// no consumer re-implements the rule and the DTO, the service and the tests
// cannot disagree about what "invited" means.
//
// WHY DERIVED RATHER THAN STORED — see the migration: a stored state has to be
// cleared by whatever set it, so a crash between the GitHub call and the write
// leaves it lying. Two stamps recompute the same answer on every read.
//
// ⚠️ ABSENCE IS A STATE, and it is why every function here takes the record as
// NULLABLE. A member who has never been invited has no row at all, and that is
// `not_invited` — the same answer as a row whose invite attempt failed before it
// could be stamped. Requiring a row to exist first would mean writing a record
// to say that nothing has happened.

/** Every access state, in the order the design's table lists them. Exported as a
 *  value so a totality test can assert the union and this list stay in lockstep. */
export const PROJECT_REPO_ACCESS_STATES = [
  'not_invited',
  'invited',
  'accepted',
] as const satisfies readonly ProjectRepoAccessStateDto[];

/** Every permission a collaborator record can carry (ADR §3 Q2). Same
 *  lockstep-with-the-union contract as the states above. */
export const PROJECT_REPO_COLLABORATOR_PERMISSIONS = [
  'push',
  'admin',
] as const satisfies readonly ProjectRepoCollaboratorPermissionDto[];

/** Why a member cannot be invited, or null when they can. The two reasons are
 *  deliberately distinct because they have different OWNERS: the first is settled
 *  and only a role change moves it; the second is actionable by that member and
 *  by NOBODY else — Motir cannot OAuth on a teammate's behalf (ADR §3 Q3). */
export const PROJECT_REPO_MEMBER_ACCESS_REASONS = [
  'role_cannot_edit',
  'no_github_identity',
] as const satisfies readonly Exclude<ProjectRepoMemberAccessReasonDto, null>[];

/** The persisted half of a collaborator record this module reads — accepted as a
 *  structural type so a caller may pass a full Prisma row, a locked re-read, or a
 *  fixture. */
export type ProjectRepoAccessColumns = Pick<
  ProjectRepoCollaborator,
  'githubLogin' | 'permission' | 'invitedAt' | 'acceptedAt' | 'invitationUrl'
>;

/**
 * The record's access STATE, or `not_invited` when there is no record.
 *
 * Order is the whole rule: `accepted` outranks `invited`, because a record that
 * was invited and then accepted is not still pending — and accepting deliberately
 * does NOT clear `invitedAt` (the row keeps both events), so reading the stamps
 * in the other order would report every accepted invitation as outstanding
 * forever.
 */
export function deriveAccessState(
  record: ProjectRepoAccessColumns | null,
): ProjectRepoAccessStateDto {
  if (record === null) return 'not_invited';
  if (record.acceptedAt !== null) return 'accepted';
  if (record.invitedAt !== null) return 'invited';
  return 'not_invited';
}

/**
 * The whole access half of a REPOSITORY row's DTO — the APPROVING USER's access,
 * which is what the establish step renders.
 *
 * ⚠️ It is fed the row's `admin` record specifically, not "the first
 * collaborator": ADR §3 Q2 reserves `admin` to the person who approved the plan,
 * so that record is exactly the one MOTIR-1900 created and the one this field has
 * always described. A teammate's `push` record belongs to the per-member read,
 * not here — which is what keeps this field's MEANING stable across the
 * cardinality retrofit instead of silently becoming "whoever happens to be
 * first".
 */
export function toAccessDto(record: ProjectRepoAccessColumns | null): ProjectRepoAccessDto {
  const state = deriveAccessState(record);
  return {
    state,
    login: record?.githubLogin ?? null,
    // Only a PENDING invitation has somewhere to open. Once accepted the URL
    // leads to an invitation that no longer exists, so it is not offered — the
    // design gives `accepted` no forward path for exactly this reason.
    invitationUrl: state === 'invited' ? (record?.invitationUrl ?? null) : null,
  };
}

/**
 * Pick the record that represents the APPROVING USER's access, out of one
 * repository row's collaborators.
 *
 * The `admin` record (ADR §3 Q2). Null when the row has none — a project whose
 * approving user never connected GitHub has teammates with `push` records and
 * nobody with `admin`, and reporting one of THEM as "the account Motir invited"
 * would answer a different question than the one this field asks.
 */
export function findOwnerAccessRecord<T extends { permission: string }>(
  records: readonly T[],
): T | null {
  return records.find((r) => r.permission === 'admin') ?? null;
}

/**
 * Is this repository row one that NEEDS collaborator invitations?
 *
 * `created` ONLY, and that is not an oversight. `created` is reachable solely
 * through `proposed → creating → created` (`lib/projectRepos/transitions.ts`), so
 * it is exactly the set of repositories MOTIR made and owns — the ones the team
 * has no access to. A `connected` row is a repository the user ALREADY owns and
 * granted Motir; inviting anyone to it is at best a no-op and at worst Motir
 * handing out access to a repository that was never its to share. The design
 * draws the invitation line on `created` rows for the same reason.
 */
export function needsCollaboratorInvite(state: ProjectRepoState): boolean {
  return state === 'created';
}
