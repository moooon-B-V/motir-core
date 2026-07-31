import type {
  ProjectRepoAccessStateDto,
  ProjectRepoCollaboratorPermissionDto,
  ProjectRepoDto,
  ProjectRepoMemberAccessDto,
  ProjectRepoMemberAccessReasonDto,
  ProjectRepoTeamAccessDto,
} from '@/lib/dto/projectRepos';

// THE TEAM CODE-ACCESS VIEW MODEL (Story MOTIR-1775 · MOTIR-1945) — the
// transposition the surface renders from, kept out of the component so it is
// testable without a DOM and cannot drift per render path.
//
// ⚠️ THE AXES ARE SWAPPED HERE, DELIBERATELY. `ProjectRepoTeamAccessDto` is
// REPOSITORY-primary because access is GRANTED per repository (MOTIR-1910); the
// surface is MEMBER-primary because the questions it answers are person-shaped —
// "can Dana clone our code?", not "who is on atlas-api?" (design §15.5). One repo
// row × N members becomes N member rows × M cells, and the roll-up below is what
// makes a member's M cells readable as one line.
//
// ⚠️ NO SECOND VOCABULARY. The per-cell states ARE
// `PROJECT_REPO_ACCESS_STATES` (`not_invited` / `invited` / `accepted`) derived by
// `lib/projectRepos/access.ts`. This module adds no state to that union: the two
// extra words a per-MEMBER view needs (`failed`, `ineligible`) are ROLL-UP
// verdicts about a person, never a cell state, and they are typed apart for
// exactly that reason.

/**
 * What ONE member's row says, across the whole invitable set.
 *
 * The first three are the cell vocabulary rolled up; the last two are person-level
 * verdicts that cannot exist on a cell:
 *
 *   * `failed`     — an invite pass this session was REFUSED by GitHub. Not a
 *     persisted state: MOTIR-1910 stamps nothing on a refusal (the repository is
 *     fine and the record is untouched), so this is knowable ONLY from the
 *     response of an attempt the reader just made. It decays on the next read,
 *     which is honest — the invitation can simply be sent again.
 *   * `ineligible` — the project's own edit permission excludes them, so there is
 *     no invitation to be in a state about (design §15.6, ADR §3 Q1).
 */
export type TeamAccessRollupState =
  | ProjectRepoAccessStateDto
  | 'failed'
  | 'ineligible'
  /** The set holds no repository Motir made, so nothing here is Motir's to grant
   *  — the degenerate end of the partial-set rule (design §15.8 C). */
  | 'nothing_to_grant';

/** ONE `(member × repository)` cell — a row of the per-repository expansion. */
export interface TeamAccessCell {
  /** The `ProjectRepo.id`, which is what a narrowed invite POSTs as `rowId`. */
  rowId: string;
  /** `owner/name` of the realized repository. */
  repoRef: string;
  permission: ProjectRepoCollaboratorPermissionDto | null;
  state: ProjectRepoAccessStateDto;
  /** Where **Open the invitation** points — a PENDING invitation only. */
  invitationUrl: string | null;
  /** This cell is one GitHub refused in the pass the reader just ran. Derived,
   *  never persisted — see `TeamAccessRollupState.failed`. */
  failed: boolean;
}

/** ONE person, and everything their row renders. */
export interface TeamAccessPerson {
  userId: string;
  name: string;
  email: string;
  eligible: boolean;
  /** The account that HOLDS (or was offered) the access — the record's snapshot
   *  when there is one, else the member's connected login, else null. */
  login: string | null;
  /** The roll-up permission. `admin` wins over `push`: it is the strictly larger
   *  grant, and the approving user keeps it on every row (ADR §3 Q2). */
  permission: ProjectRepoCollaboratorPermissionDto | null;
  state: TeamAccessRollupState;
  reason: ProjectRepoMemberAccessReasonDto;
  cells: TeamAccessCell[];
  /** How many of their cells are `invited` or `accepted` — the expander's
   *  "· {sent} sent" half. */
  sentCount: number;
  acceptedCount: number;
  /** The first repository GitHub refused, for the row's reason line. */
  failedRepoRef: string | null;
  /** The repositories disagree, so the expansion OPENS BY DEFAULT (design §15.5):
   *  the common case reads as one line, the case that needs M lines gets them. */
  disagree: boolean;
}

/** One chip of the repository SET strip — the M axis, named once. */
export interface TeamAccessRepoChip {
  rowId: string;
  /** `owner/name` when the repository exists, else the row's authored name. */
  label: string;
  /** Motir made it and it can hold invitations — a plain chip. */
  invitable: boolean;
  /** The team already owned it and granted Motir access; reached through GitHub,
   *  not through Motir (`needsCollaboratorInvite`). */
  connected: boolean;
  /** No repository behind the row yet (proposed / creating / skipped / failed). */
  established: boolean;
}

export interface TeamAccessView {
  /** The set strip — EVERY row of the set, including the ones nothing is granted
   *  on, because a chip that silently vanished would make a partial set read as a
   *  smaller complete one. */
  repos: TeamAccessRepoChip[];
  /** How many rows can actually hold invitations. `0` with a non-empty set is the
   *  `nothing_to_grant` case. */
  invitableCount: number;
  /** The invitable members, in the order the read returned them. */
  people: TeamAccessPerson[];
  /** The members the project's edit permission excludes — their OWN card, never a
   *  greyed row in the list (design §15.6). */
  ineligible: TeamAccessPerson[];
  /**
   * How many eligible members can ACTUALLY clone — `accepted` on every invitable
   * repository.
   *
   * ⚠️ Counts what is TRUE, not what was attempted (design §15.6): a pending
   * invitation is not access, and counting it as one would restate the very
   * invisibility this Story exists to fix.
   */
  grantedCount: number;
  eligibleCount: number;
  /** A repository still being made — the mid-establish banner names it. */
  establishingRepoName: string | null;
}

/** The rows a member can be invited to: Motir made them and they are realized. */
function invitableRows(access: ProjectRepoTeamAccessDto) {
  return access.rows.filter((row) => row.invitable && row.repoRef !== null);
}

/**
 * Roll ONE member's cells up into the single line their row leads with.
 *
 * Order is the rule, and it is severity-first: a refusal outranks everything
 * because it is the only thing anyone must act on; `accepted` requires EVERY
 * invitable repository (a member who can clone two of three cannot clone the
 * project's code); anything sent is pending; otherwise nothing has been asked.
 */
function rollUp(
  cells: readonly TeamAccessCell[],
  eligible: boolean,
): { state: TeamAccessRollupState; sentCount: number; acceptedCount: number } {
  const acceptedCount = cells.filter((c) => c.state === 'accepted').length;
  const sentCount = cells.filter((c) => c.state !== 'not_invited').length;

  if (!eligible) return { state: 'ineligible', sentCount, acceptedCount };
  if (cells.length === 0) return { state: 'nothing_to_grant', sentCount, acceptedCount };
  if (cells.some((c) => c.failed)) return { state: 'failed', sentCount, acceptedCount };
  if (acceptedCount === cells.length) return { state: 'accepted', sentCount, acceptedCount };
  if (sentCount > 0) return { state: 'invited', sentCount, acceptedCount };
  return { state: 'not_invited', sentCount, acceptedCount };
}

/**
 * Build the member-primary view the surface renders.
 *
 * `failedUserIds` marks the members whose last invite pass GitHub refused. It is
 * passed IN rather than read from the DTO because a refusal persists nothing —
 * MOTIR-1910 leaves the record untouched so the repository stays real and the
 * invitation stays retryable — so the only honest source is the response the
 * caller just received. A refused cell is therefore identified as "still
 * `not_invited` after a pass that tried it", which is exactly what it is.
 */
export function buildTeamAccessView(
  access: ProjectRepoTeamAccessDto,
  repos: readonly ProjectRepoDto[],
  options: { failedUserIds?: ReadonlySet<string> } = {},
): TeamAccessView {
  const failedUserIds = options.failedUserIds ?? new Set<string>();
  const rows = invitableRows(access);

  // The member axis comes from the read's own member list — every row carries the
  // same candidate set (MOTIR-1910 crosses the two), so the FIRST row's members
  // are the roster and the others contribute their cells.
  const roster: ProjectRepoMemberAccessDto[] = access.rows[0]?.members ?? [];

  const people = roster.map<TeamAccessPerson>((member) => {
    // A row that does not carry this member contributes NO cell — it is never
    // filled in from another row's answer. The read crosses every row with the
    // same candidate set, so this only fires on a set that changed mid-read, and
    // omitting the cell says "not known" where inventing one would say something
    // false about a repository nobody asked about.
    const cells = rows.flatMap<TeamAccessCell>((row) => {
      const cell = row.members.find((m) => m.userId === member.userId);
      if (!cell) return [];
      return {
        rowId: row.rowId,
        repoRef: row.repoRef as string,
        permission: cell.permission,
        state: cell.state,
        invitationUrl: cell.invitationUrl,
        // Only a member the pass actually TRIED can have been refused: an
        // ineligible member and one with no account were never sent, and marking
        // either as failed would blame GitHub for a state Motir chose.
        failed:
          failedUserIds.has(member.userId) &&
          member.eligible &&
          member.reason === null &&
          cell.state === 'not_invited',
      };
    });

    const { state, sentCount, acceptedCount } = rollUp(cells, member.eligible);
    const permissions = cells.map((c) => c.permission).filter((p) => p !== null);

    return {
      userId: member.userId,
      name: member.name,
      email: member.email,
      eligible: member.eligible,
      login: member.login,
      permission: permissions.includes('admin') ? 'admin' : (permissions[0] ?? null),
      state,
      reason: member.reason,
      cells,
      sentCount,
      acceptedCount,
      failedRepoRef: cells.find((c) => c.failed)?.repoRef ?? null,
      // One repository cannot disagree with itself, so a single-repo project never
      // opens a row — the degenerate case of the same rule, not a second path.
      disagree: new Set(cells.map((c) => (c.failed ? 'failed' : c.state))).size > 1,
    };
  });

  const eligible = people.filter((p) => p.eligible);

  return {
    repos: repos.map<TeamAccessRepoChip>((repo) => ({
      rowId: repo.id,
      label: repo.realizedRepo?.repoRef ?? repo.name,
      invitable: rows.some((r) => r.rowId === repo.id),
      connected: repo.state === 'connected',
      established: repo.established,
    })),
    invitableCount: rows.length,
    people: eligible,
    ineligible: people.filter((p) => !p.eligible),
    grantedCount: eligible.filter((p) => p.state === 'accepted').length,
    eligibleCount: eligible.length,
    establishingRepoName: repos.find((r) => r.state === 'creating')?.name ?? null,
  };
}

/**
 * The counts DOOR 2 carries — `{granted} of {eligible} people who can edit can
 * clone this project's code`.
 *
 * The door is a number and not just a label on purpose (design §15.3): the failure
 * this Story exists to fix was INVISIBLE — five of six people could not clone their
 * own project's code and nothing said so anywhere — and a door labelled only "Code
 * access" would reproduce it.
 */
export function teamAccessSummary(
  access: ProjectRepoTeamAccessDto,
  repos: readonly ProjectRepoDto[],
): { granted: number; eligible: number } {
  const view = buildTeamAccessView(access, repos);
  return { granted: view.grantedCount, eligible: view.eligibleCount };
}
