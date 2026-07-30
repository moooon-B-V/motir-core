// DTO types for the project REPOSITORY SET (Story MOTIR-1775 · MOTIR-1780) — the
// shape that crosses the API boundary. No Prisma row leaks: the Prisma
// `ProjectRepoRole` / `ProjectRepoState` / `ProjectRepoOwnership` enums become
// string unions and every `Date` becomes an ISO string. The establish-step UI
// (MOTIR-1782), the derivation (MOTIR-1881) and the dispatch resolver
// (MOTIR-1783) bind to these.

/** Wire form of the Prisma `ProjectRepoRole` enum (ADR §1.1). */
export type ProjectRepoRoleDto = 'web' | 'api' | 'mobile' | 'shared' | 'infra' | 'other';

/** Wire form of the Prisma `ProjectRepoState` enum (ADR §4.1). */
export type ProjectRepoStateDto =
  | 'proposed'
  | 'creating'
  | 'created'
  | 'connected'
  | 'skipped'
  | 'failed';

/** Wire form of the Prisma `ProjectRepoOwnership` enum (ADR §3). */
export type ProjectRepoOwnershipDto = 'user' | 'motir';

/**
 * The REALIZED repository behind a set row — the connected `GithubRepo` mirror
 * row, present only once creation or connect-existing has completed.
 *
 * `name` here is AUTHORITATIVE for a checkout: it is the host's own casing, which
 * is what `work_item.targetRepo` stores and the CLI keys `<root>/<name>` on. It
 * can legitimately differ from the row's authored `name` (someone renamed the
 * repo on the host), which is precisely why the two are carried separately rather
 * than the row's `name` being overwritten.
 */
export interface RealizedProjectRepoDto {
  /** Internal `GithubRepo.id` (a cuid) — the FK the creation primitive attached. */
  id: string;
  /** The git-provider discriminator (`"github"` / `"gitlab"` — the GitProvider seam). */
  provider: string;
  owner: string;
  name: string;
  /** `owner/name` — the display form the GitHub surfaces + `resolveCodeContext` use. */
  repoRef: string;
  defaultBranch: string;
}

/**
 * One row of a project's repository set as it crosses the API boundary.
 *
 * `realizedRepo` is the honest signal of whether the repository EXISTS right now,
 * and it is separate from `state` on purpose. `state` records what HAPPENED (this
 * row was created / connected / skipped / failed); `realizedRepo` records what is
 * true NOW. They can legitimately disagree in exactly one direction: a row that
 * was `created` or `connected` whose `GithubRepo` mirror row has since been
 * deleted (the installation was reconfigured, the repo disconnected) carries a
 * settled state with `realizedRepo: null` — a disconnected repo is not a lost
 * plan, and `established` is what a consumer should branch on.
 */
export interface ProjectRepoDto {
  id: string;
  projectId: string;
  role: ProjectRepoRoleDto;
  /** The free-form label distinguishing repeated roles (`api` + "billing"). */
  label: string | null;
  /** The authored/intended repo name — editable until the row is established. */
  name: string;
  seedSource: string;
  state: ProjectRepoStateDto;
  failureReason: string | null;
  /** The connected repository this row realizes, or null when it has none yet
   *  (or no longer has one — see the type doc). */
  realizedRepo: RealizedProjectRepoDto | null;
  /**
   * Whether this row names a repository that EXISTS — `state` is `created` or
   * `connected` AND the realized repo is still present. Derived here so no
   * consumer re-implements the two-part rule and none of them can drift from
   * `resolveProjectRepoNames`, which filters on exactly this.
   */
  established: boolean;
  /** Fractional order key. The FIRST row of the ordered set is the project's
   *  PRIMARY repo (ADR §1.3); order carries no dispatch meaning. */
  position: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A project's repository set plus the SET-level ownership decision (ADR §3.2 /
 * §3.4) — one read, because a consumer that has the rows without knowing whose
 * account they live in cannot render or transfer them. `ownership` /
 * `targetAccount` are null until the establish step decides.
 */
export interface ProjectRepoSetDto {
  projectId: string;
  rows: ProjectRepoDto[];
  ownership: ProjectRepoOwnershipDto | null;
  targetAccount: string | null;
}

/** Input to `projectRepoSetService.addRow` — appends a row to the end of the set.
 *  `seedSource` defaults from the role via ADR §2's table; `state` is always
 *  `proposed` (nothing is created until the set is confirmed). */
export interface AddProjectRepoInput {
  role: ProjectRepoRoleDto;
  name: string;
  label?: string | null;
  /** Override ADR §2's default for the role — the seam MOTIR-709's starter
   *  registry will use. Omit for the default. */
  seedSource?: string;
}

/** Input to `projectRepoSetService.patchRow` — a PARTIAL edit of an unestablished
 *  row (the UI edits the set before executing it). Only the keys present are
 *  written; `label: null` clears the label. */
export interface PatchProjectRepoInput {
  role?: ProjectRepoRoleDto;
  name?: string;
  label?: string | null;
  seedSource?: string;
}

/** Input to `projectRepoSetService.setOwnership` — the SET-level target decision
 *  (ADR §3.2: one choice for the whole set, never per row). */
export interface SetProjectRepoOwnershipInput {
  ownership: ProjectRepoOwnershipDto;
  /** The account login the repositories live under. */
  targetAccount: string;
}
