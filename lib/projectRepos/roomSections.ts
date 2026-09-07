import type { ProjectRepoConnectedDto, ProjectRepoDto } from '@/lib/dto/projectRepos';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';

// THE ROOM'S SECTIONS, split by ONE rule each (MOTIR-3126; a THIRD arrived with
// MOTIR-4669 · MOTIR-4681) —
// `/settings/project/repositories` renders the Motir-hosted SET and the
// workspace-CONNECTED repositories separately, and this is the only place that
// decides which side a repository falls on.
//
// ⚠️ PURE, AND CLIENT-SAFE ON PURPOSE. The split is applied twice — once on the
// server, seeding the room, and once in the client island, which re-reads the
// establish view after every mutation and on the takeover poll. Two
// implementations of "is this repository already one of the rows?" is exactly how
// a repository comes to appear in both sections at once, so there is one, and it
// imports nothing that would drag a workspace context into a bundle.
//
// ⚠️ IT DOES NOT DECIDE WHETHER THE SECTION EXISTS. That is the LADDER's answer
// (`ProjectRepoRoomViewDto.connectedInDomain`, resolved by
// `lib/projectRepos/effectiveDomain.ts` on the server). This function only removes
// duplicates from a list the caller has already been told belongs on the page.
//
// ── ⚠️ THE THIRD SECTION, AND THE SEAM IT CLOSES (MOTIR-4681) ────────────────
// A repository PICKED from the organisation gets a `project_repository` row — it
// has to, because `@@unique([projectId, githubRepoId])` is the guarantee
// MOTIR-4648 preserved. That row therefore enters `view.rows`, and `rows` was
// rendered wholesale as Motir-hosted `TakeoverRow`s: a picked repository would
// have offered **Take it over** for a repository the organisation already owns,
// and `connectedNotInSet`'s name de-duplication would have removed it from the
// section it belongs to at the same time.
//
// The discriminator is the row's own `seedSource`, and it is a FACT the write
// records rather than a heuristic the reader infers: every other seed source
// answers *"what will Motir put in the repository it is about to create?"*;
// `SEED_SOURCE_ORGANIZATION` answers *"nothing — it already exists."* A
// name-match or an owner-match would each have been a second guess layered on the
// one that already misfires here.

/**
 * The repository NAME a set row occupies in the domain — the REALIZED repo's own
 * name where there is one, else the row's authored name.
 *
 * The same preference `toProjectRepoNames` applies, and for the same reason: the
 * host's casing is what a checkout answers to, and the two can legitimately differ
 * once someone renames the repository on GitHub.
 */
function rowName(row: ProjectRepoDto): string {
  return (row.realizedRepo?.name ?? row.name).toLowerCase();
}

/**
 * The connected repositories that are NOT already one of the set's rows.
 *
 * De-duplicated by NAME, case-insensitively — the rule
 * `mergeDomainsByName` applies when it merges the same two registries for
 * dispatch, so a repository the room shows once is a repository dispatch resolves
 * once. Matching on the `github_repo_id` instead would be narrower and wrong here:
 * a row that names a repository it has not realized yet has no id to match on, and
 * it is still the row that owns that name.
 *
 * Order is the connected list's own, which is `owner`-then-`name` from the
 * installation — stable, and not something this surface should re-sort.
 */
export function connectedNotInSet(
  rows: readonly ProjectRepoDto[],
  connected: readonly ProjectRepoConnectedDto[],
): ProjectRepoConnectedDto[] {
  const claimed = new Set(rows.map(rowName));
  const seen = new Set<string>();
  const out: ProjectRepoConnectedDto[] = [];
  for (const repo of connected) {
    const key = repo.name.toLowerCase();
    if (claimed.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/**
 * Split the set's rows into the two things a reader is actually looking at: the
 * repositories that came FROM THE ORGANISATION, and the ones Motir hosts or plans
 * to (MOTIR-4681).
 *
 * ⚠️ ONE ROW NEVER APPEARS IN BOTH, and the split is total: every row falls on
 * exactly one side, so a row cannot be lost by a future third arm being added
 * without its own branch.
 *
 * The org side carries `Remove from this project` — the first affordance a
 * repository in that half has ever had, and a legitimate one: a project's LINK to
 * an organisation repository is exactly the thing a project may change. The
 * hosted side keeps the takeover, which is meaningless for a repository the
 * organisation already owns.
 */
export function splitSetRowsByOrigin(rows: readonly ProjectRepoDto[]): {
  fromOrganization: ProjectRepoDto[];
  motirHosted: ProjectRepoDto[];
} {
  const fromOrganization: ProjectRepoDto[] = [];
  const motirHosted: ProjectRepoDto[] = [];
  for (const row of rows) {
    (isOrganizationSeedSource(row.seedSource) ? fromOrganization : motirHosted).push(row);
  }
  return { fromOrganization, motirHosted };
}

/**
 * The header summary's three counts, over BOTH registries (MOTIR-3126).
 *
 * Three ownerships in one project are LEGAL AT ONCE (MOTIR-711's per-row rule at
 * set scale), so they are counted separately rather than implying the whole
 * project is "moving" because one row is.
 *
 * ⚠️ A CONNECTED REPOSITORY COUNTS AS `yours`, because it is: the user owns it,
 * Motir never bills its CI, and there is nothing to move. A summary computed over
 * the set alone is the header-level form of the very defect this card fixes — it
 * would report `0 yours` on a project holding four repositories of its own.
 */
export function summarizeRepositories(
  rows: readonly ProjectRepoDto[],
  connected: readonly ProjectRepoConnectedDto[],
): { moving: number; hosted: number; yours: number } {
  let moving = 0;
  let hosted = 0;
  let yours = connected.length;
  for (const row of rows) {
    const takeover = row.takeover?.state ?? null;
    if (takeover && takeover !== 'done' && takeover !== 'failed') moving += 1;
    else if (takeover === 'done' || row.state === 'connected') yours += 1;
    else if (row.state === 'created') hosted += 1;
  }
  return { moving, hosted, yours };
}
