import type { ProjectRepoConnectedDto, ProjectRepoDto } from '@/lib/dto/projectRepos';
import { isMotirHostedOwner } from '@/lib/git/hostOwnership';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';

// THE ROOM'S SECTIONS, split by ONE rule each (MOTIR-3126; a THIRD arrived with
// MOTIR-4669 · MOTIR-4681; the ORG side moved onto the LADDER in MOTIR-4820) —
// `/settings/project/repositories` renders the Motir-hosted SET and the
// organisation's repositories separately, and this is the only place that
// decides which side a repository falls on.
//
// ⚠️ PURE, AND CLIENT-SAFE ON PURPOSE. The split is applied twice — once on the
// server, seeding the room, and once in the client island, which re-reads the
// establish view after every mutation and on the takeover poll. Two
// implementations of "is this repository already one of the rows?" is exactly how
// a repository comes to appear in both sections at once, so there is one, and it
// imports nothing that would drag a workspace context into a bundle.
//
// ⚠️ IT DOES NOT DECIDE WHETHER THE LADDER LAYERS. That is the LADDER's answer
// (`ProjectRepoRoomViewDto.connectedInDomain`, resolved by
// `lib/projectRepos/effectiveDomain.ts` on the server). This function is HANDED
// that boolean; it never re-derives it, and it never reads a count in its place.
//
// ── ⚠️ THE ORG SECTION ANSWERS THE LADDER, NOT `seedSource` (MOTIR-4820) ──────
// A repository PICKED from the organisation gets a `project_repository` row — it
// has to, because `@@unique([projectId, githubRepoId])` is the guarantee
// MOTIR-4648 preserved. `seedSource === 'organization'` is the FACT that write
// records, and for a year it was also the whole of the org section: the section
// held the picked rows and nothing else.
//
// **That made the room and the organisation's inventory answer the same question
// differently.** MOTIR-4802 moved `Used by N projects` onto the ladder, so
// `/settings/organization/git` reads `Used by <project>` for every repository a
// set-less project layers — while this room, still keyed on the link table, drew
// an EMPTY `From your organisation` thirty pixels above those same repositories
// under `Your own repositories`. Both halves behaved exactly as written and a
// reader could not hold both.
//
// So the org section is now the ladder's own answer, in two parts that render as
// one list:
//
//   - a LINK  — a `project_repository` row somebody picked. It has a row id, so
//               it carries `Remove from this project`.
//   - a DOMAIN entry — a repository the ladder LAYERS into this project's domain
//               with no row of its own. There is nothing to remove, so it carries
//               no action, exactly as it did in the section it came from.
//
// `seedSource` still decides which rows are LINKS rather than Motir-hosted ones;
// what it no longer decides is whether a repository is the organisation's. The
// old `Your own repositories` section is gone with its copy — it named the
// WORKSPACE, which stopped being the tier that owns a repository at MOTIR-4649.

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
 * The OWNER segment of a connected repository's `repoRef` — `owner` of
 * `owner/name`, or null for a ref that somehow holds no `/`.
 *
 * `ProjectRepoConnectedDto` deliberately carries no `owner` column (its own doc
 * says why: the room's domain read has none to carry), so `repoRef` is where the
 * owner lives. The cut is `lastIndexOf('/')`, which is the SAME split
 * `OrganizationRepositories.ownerPrefix` already renders the row with — so the
 * owner this module classifies on is byte-for-byte the owner the reader sees.
 */
function connectedOwner(repo: ProjectRepoConnectedDto): string | null {
  const cut = repo.repoRef.lastIndexOf('/');
  return cut === -1 ? null : repo.repoRef.slice(0, cut);
}

/**
 * Is this connected repository one MOTIR HOSTS — i.e. does it sit under the
 * provisioning organisation? (bug MOTIR-4867.)
 *
 * ⚠️ IT TAKES `hostOwner` RATHER THAN READING IT. `provisioningOrgLogin()` is
 * `process.env['GITHUB_FALLBACK_ORG']`, a SERVER value, and this module is pure
 * and client-safe on purpose (the header says why). Reading it here would give
 * the server and the island two different answers to one question, which is the
 * exact class of bug this file exists to end. The server puts it on
 * `ProjectRepoRoomViewDto.hostOwner`; both callers pass it down from there.
 *
 * ⚠️ AND IT IS LITERALLY THE SAME COMPARISON the organisation's inventory and
 * the CI meter's §5.1 gate make — {@link isMotirHostedOwner}, since bug
 * MOTIR-4892 gave the three of them one predicate. It used to be spelled out
 * here, correctly, and spelled out again in `lib/ciMetering/config.ts`, also
 * correctly, while `/settings/organization/git` made no such comparison at all —
 * which is how one row read as the organisation's on one page and as Motir's on
 * the page thirty pixels of navigation away.
 *
 * **`hostOwner: null` classifies NOTHING.** A deployment that cannot provision
 * (self-hosted, no `GITHUB_FALLBACK_ORG`) hosts no repositories, so there is
 * nothing to hold back and the room renders exactly what it rendered before this
 * rule existed.
 */
export function isMotirHostedConnectedRepo(
  repo: ProjectRepoConnectedDto,
  hostOwner: string | null,
): boolean {
  return isMotirHostedOwner(connectedOwner(repo), hostOwner);
}

/**
 * The connected repositories that are the ORGANISATION'S — everything the
 * ladder layers MINUS the ones Motir hosts (bug MOTIR-4867).
 *
 * ── WHY THE ROOM HAS TO SUBTRACT AT ALL ─────────────────────────────────────
 * `connected` comes from `githubRepoRepository.listByWorkspace`, which filters on
 * `github_repo.workspace_id` and NOTHING else. That is correct and must stay
 * correct: MOTIR-1931 moved it off the installation join precisely so a
 * repository Motir CREATES for a workspace is a legal `targetRepo`, and
 * `githubInstallationService.persistProvisionedRepo` writes the creating
 * project's `workspace_id` onto exactly such a row (behind an installation that
 * is `organizationId: null`, because it is shared across tenants).
 *
 * So the registry answers **"can this workspace dispatch into it?"** and the room
 * was reading it as **"whose is it?"**. Those are different questions with the
 * same list. A Motir-hosted repository the CURRENT project holds no
 * `project_repository` row for therefore survived `connectedNotInSet` and was
 * drawn under `From your organisation` — _"Repositories {org} is connected to"_ —
 * and counted in `yours`, whose own meaning below is *the user owns it, Motir
 * never bills its CI, and there is nothing to move*. All three were false at
 * once, on the one row of the page that is transferable.
 *
 * ⚠️ THE FIX IS A CLASSIFICATION, NEVER A NARROWER READ. Filtering inside
 * `listConnectedRepoNames` / `listByWorkspace` would un-dispatch every hosted
 * repository to correct a settings page.
 *
 * ── WHY IT IS SUBTRACTED RATHER THAN MOVED ──────────────────────────────────
 * `Hosted by Motir` is the project's own `project_repository` rows — the ones
 * carrying the takeover saga, whose hint reads *"Motir created these and pays for
 * their CI. Move any of them to your own GitHub whenever you want."* An entry
 * with no row has no takeover to offer, so it would sit under that sentence with
 * the one affordance the sentence promises absent; `design-notes.md` §16.2 puts
 * it plainly — the sections answer *which registry is this row in*, and a
 * repository with no row is in neither of the room's.
 *
 * And the room's OTHER half already answers for it: `otherHostedProjects` is the
 * drawn pointer to the sibling projects whose code Motir also hosts (§14.4). A
 * hosted repository this project holds no link to is that surface's business, not
 * this section's.
 *
 * ⚠️ AND IT MAKES THE TWO HALVES OF THIS ROOM AGREE, which they did not. The
 * client island re-reads the establish view after every mutation and rebuilds
 * `connected` from `connectCandidates` — sourced from
 * `listOrganizationInstallations`, which the shared provisioning installation is
 * NOT in (it names no organisation). So the offending row was present on the
 * server render and GONE after the first mutation. Subtracting it here settles
 * both renders on the org-scoped answer, which is also the one
 * `get_project_state` reports.
 */
export function organizationConnected(
  connected: readonly ProjectRepoConnectedDto[],
  hostOwner: string | null,
): ProjectRepoConnectedDto[] {
  return connected.filter((repo) => !isMotirHostedConnectedRepo(repo, hostOwner));
}

/**
 * ONE ROW OF THE ORGANISATION SECTION — and which of the two things it is.
 *
 * The section renders a single list. This union is what lets it stay one list
 * while remaining honest about the one way its members differ: a `link` is a
 * `project_repository` row this project chose and may drop, a `domain` entry is a
 * repository the ladder hands the project and there is no link to drop.
 */
export type OrgSectionEntry =
  | { kind: 'link'; id: string; row: ProjectRepoDto }
  | { kind: 'domain'; id: string; repo: ProjectRepoConnectedDto };

/**
 * THE ROOM'S TWO SECTIONS (MOTIR-4820).
 *
 * ⚠️ ONE REPOSITORY NEVER APPEARS TWICE, and the split is total: every set row
 * falls on exactly one side, and `connected` has already been de-duplicated
 * against the rows by {@link connectedNotInSet} — which is why the domain half is
 * appended rather than merged again here.
 *
 * `layersConnected` is the LADDER's own boolean, straight from the server
 * (`ProjectRepoRoomViewDto.connectedInDomain`). It is NOT `connected.length > 0`:
 * a project whose domain includes the workspace rung but whose organisation has
 * nothing connected yet still layers it, and conflating the two is the class of
 * bug this module exists to end.
 *
 * The org side carries `Remove from this project` on its LINK rows only. The
 * hosted side keeps the takeover, which is meaningless for a repository the
 * organisation already owns.
 *
 * ⚠️ `hostOwner` IS REQUIRED, not optional (bug MOTIR-4867). The layered half is
 * the ORGANISATION'S repositories, so a caller that cannot say who owns them
 * cannot compute this section — and a defaulted parameter is a gate one caller
 * away from being missing. `null` is a legitimate ANSWER (a deployment that
 * cannot provision hosts nothing), never an omission.
 */
export function splitRoomSections(
  rows: readonly ProjectRepoDto[],
  connected: readonly ProjectRepoConnectedDto[],
  layersConnected: boolean,
  hostOwner: string | null,
): { fromOrganization: OrgSectionEntry[]; motirHosted: ProjectRepoDto[] } {
  const fromOrganization: OrgSectionEntry[] = [];
  const motirHosted: ProjectRepoDto[] = [];
  for (const row of rows) {
    if (isOrganizationSeedSource(row.seedSource)) {
      fromOrganization.push({ kind: 'link', id: row.id, row });
    } else {
      motirHosted.push(row);
    }
  }
  if (layersConnected) {
    for (const repo of organizationConnected(connected, hostOwner)) {
      fromOrganization.push({ kind: 'domain', id: repo.repoRef, repo });
    }
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
 *
 * ⚠️ UNLESS MOTIR HOSTS IT, WHEN ALL THREE OF THOSE CLAUSES INVERT (bug
 * MOTIR-4867). The sentence above is the promise `yours` makes, and for a
 * repository under the provisioning organisation Motir owns it, Motir pays its
 * Actions, and moving it is a whole saga — so it is subtracted here by the same
 * {@link organizationConnected} rule that keeps it out of the section, and the
 * two cannot drift because they are one predicate.
 *
 * ⚠️ `hosted` STILL COUNTS ROWS ONLY, deliberately. It is the count of what
 * `Hosted by Motir` DRAWS, and that section draws `project_repository` rows; a
 * hosted repository this project holds no row for is not in it, so counting it
 * would put a number above a section that does not contain it. `0 hosted by
 * Motir` on a project whose set is empty is therefore true, not an omission.
 */
export function summarizeRepositories(
  rows: readonly ProjectRepoDto[],
  connected: readonly ProjectRepoConnectedDto[],
  hostOwner: string | null,
): { moving: number; hosted: number; yours: number } {
  let moving = 0;
  let hosted = 0;
  let yours = organizationConnected(connected, hostOwner).length;
  for (const row of rows) {
    const takeover = row.takeover?.state ?? null;
    if (takeover && takeover !== 'done' && takeover !== 'failed') moving += 1;
    else if (takeover === 'done' || row.state === 'connected') yours += 1;
    else if (row.state === 'created') hosted += 1;
  }
  return { moving, hosted, yours };
}
