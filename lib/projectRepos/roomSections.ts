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
// ── ⚠️ RE-SCOPED TO THE PROJECT'S LINKS (MOTIR-4954) ────────────────────────
// The block below describes the room as it was between MOTIR-4820 and this card:
// an org section that answered the LADDER, holding picked LINKS and layered
// DOMAIN entries as one list. **The domain half is gone.** A project-scoped page
// draws the project's links and nothing else, and the organisation's inventory is
// reached from the `Add repository` picker and the `See every repository in {org}`
// navigation block instead (`design/github/design-notes.md` §18).
//
// It is KEPT rather than deleted because the question it answers — *what made the
// two surfaces disagree?* — is still the reason `/settings/organization/git` and
// this room have to be read together, and because a reader meeting `connectedNotInSet`
// below needs to know what it was for.
//
// ⚠️ WHICH IS THE OTHER THING TO SAY HERE: `connectedNotInSet`,
// `organizationConnected` and `isMotirHostedConnectedRepo` SURVIVE THIS CARD AND
// ARE NOT DEAD. This room no longer calls any of them, but
// `lib/services/projectRepoRoomService.ts` still applies `connectedNotInSet` when
// it composes the room view, and `tests/projectRepos/hostOwnershipAgreement.test.ts`
// pins `organizationConnected` against the two sibling surfaces that share its
// predicate. Deleting them here would turn `main` red for a caller this card is
// not allowed to touch. Their last consumer goes with MOTIR-4955, which retires
// the workspace rung itself — that is the card that gets to delete them.

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
 * ONE ROW OF THE ORGANISATION SECTION.
 *
 * ⚠️ IT IS A ONE-MEMBER UNION NOW (MOTIR-4954), and it is kept as a union rather
 * than flattened to `ProjectRepoDto` deliberately. It used to carry a second
 * arm — a `domain` entry, a repository the LADDER layered into this project with
 * no `project_repository` row of its own — and the whole point of this card is
 * that a project-scoped page has no business drawing one. Keeping the shape means
 * the row renderers keep saying WHICH kind of thing they are printing, so an
 * attempt to re-introduce a rowless entry has to widen this type in the open
 * rather than slip in as a differently-shaped object.
 *
 * `design/github/design-notes.md` §18.3, Panel 8: *"Four page rows mean four
 * project links … Nothing else in the organisation is drawn."*
 */
export type OrgSectionEntry = { kind: 'link'; id: string; row: ProjectRepoDto };

/**
 * THE ROOM'S TWO SECTIONS (MOTIR-4820; RE-SCOPED TO PROJECT LINKS BY MOTIR-4954).
 *
 * ⚠️ THE PAGE DRAWS THIS PROJECT'S LINKS AND NOTHING ELSE. It used to append a
 * DOMAIN half — every repository the ladder layers into the project with no
 * `project_repository` row — and that half is what put the ORGANISATION's whole
 * inventory on a PROJECT-scoped page: one project holding a single link rendered
 * SEVEN rows, with `moooon-B-V/motir-core` drawn twice, once carrying
 * `Remove from this project` and once carrying nothing at all
 * (`design/github/design-notes.md` §18.2, walked against the running app).
 *
 * ⚠️ THE DUPLICATE IS FIXED BY REMOVING ITS CAUSE, NOT BY A TIGHTER DEDUP. The
 * server already applied `connectedNotInSet` and the surviving twin came from the
 * ISLAND's post-mutation recompute, deduping against a `rowsRef` that did not yet
 * hold the row just added. A hardened dedup would be dead code guarding a list
 * that no longer exists — with the domain half gone there is nothing left to
 * de-duplicate AGAINST, so the duplicate cannot recur.
 *
 * ⚠️ AND THE ORGANISATION'S REPOSITORIES DID NOT BECOME UNREACHABLE — they moved
 * to the two places a person is actually choosing from them: the `Add repository`
 * picker (§18.3 Panels 10–11) and the `See every repository in {org}` navigation
 * block (§18.6). What this function stopped doing is rendering them as PAGE ROWS.
 *
 * ⚠️ WHAT THIS FUNCTION NO LONGER TAKES, AND WHY THAT IS THE POINT.
 * `layersConnected` and `hostOwner` are gone from the signature. The first was
 * the LADDER's own boolean and the second decided whose the layered half was —
 * both questions about a list this surface does not draw. A parameter kept "just
 * in case" is how a retired section grows back; the ladder itself is untouched
 * and stays exactly where it is, in `lib/projectRepos/effectiveDomain.ts`, for
 * dispatch (MOTIR-4955 owns that rung's retirement, not this card).
 *
 * `seedSource` still decides which rows are organisation LINKS and which are
 * Motir-hosted takeover rows — a FACT the write records, never a heuristic the
 * reader infers. The hosted side keeps the takeover, which is meaningless for a
 * repository the organisation already owns.
 */
export function splitRoomSections(rows: readonly ProjectRepoDto[]): {
  fromOrganization: OrgSectionEntry[];
  motirHosted: ProjectRepoDto[];
} {
  const fromOrganization: OrgSectionEntry[] = [];
  const motirHosted: ProjectRepoDto[] = [];
  for (const row of rows) {
    if (isOrganizationSeedSource(row.seedSource)) {
      fromOrganization.push({ kind: 'link', id: row.id, row });
    } else {
      motirHosted.push(row);
    }
  }
  return { fromOrganization, motirHosted };
}

/**
 * THE HEADER SUMMARY'S THREE COUNTS, OVER THE PROJECT'S LINKS ALONE
 * (MOTIR-3126; RE-SCOPED BY MOTIR-4954).
 *
 * `{moving} moving · {hosted} hosted by Motir · {yours} yours` partitions the
 * repositories LINKED TO THIS PROJECT. The three are mutually exclusive, and
 * `design/github/design-notes.md` §18.4 states each one's meaning:
 *
 *   moving          · a Motir-hosted link whose takeover is in progress.
 *   hosted by Motir · a settled Motir-hosted link Motir still owns and pays CI for.
 *   yours           · an organisation-owned link, OR a Motir-hosted link whose
 *                     takeover COMPLETED. (Such a row keeps its place in the
 *                     hosted SECTION, where the takeover history stays legible,
 *                     while its summary bucket moves — the section answers
 *                     "where did this come from", the count answers "who owns it
 *                     now", and those are different questions.)
 *
 * ⚠️ AN ORGANISATION REPOSITORY THIS PROJECT HAS NOT ADDED IS IN NONE OF THEM.
 * This function used to SEED `yours` with `organizationConnected(connected)` —
 * every repository the ladder layered in — on the reasoning that the user owns
 * it, Motir never bills its CI and there is nothing to move. All three clauses
 * are true and the count was still wrong for this header, because the header
 * sits above a list of the PROJECT's repositories: it reported `0 moving · 0
 * hosted by Motir · 6 yours` on a project holding **no links at all** (§18.2,
 * observed). A number above a list must count the things in that list.
 *
 * ⚠️ SO THE `connected` AND `hostOwner` PARAMETERS ARE GONE, NOT DEFAULTED. The
 * only reason this function needed to know who hosts a connected repository was
 * to subtract Motir's own from that seed (bug MOTIR-4867); with no seed there is
 * nothing to subtract, and a parameter kept for a subtraction that no longer
 * happens is how the seed grows back.
 *
 * ⚠️ `hosted` STILL COUNTS ROWS, as it always did — it is the count of what the
 * `Hosted by Motir` section DRAWS. `0 hosted by Motir` on a project whose links
 * are all the organisation's is therefore true, not an omission.
 */
export function summarizeRepositories(rows: readonly ProjectRepoDto[]): {
  moving: number;
  hosted: number;
  yours: number;
} {
  let moving = 0;
  let hosted = 0;
  let yours = 0;
  for (const row of rows) {
    const takeover = row.takeover?.state ?? null;
    if (takeover && takeover !== 'done' && takeover !== 'failed') moving += 1;
    else if (takeover === 'done' || row.state === 'connected') yours += 1;
    else if (row.state === 'created') hosted += 1;
  }
  return { moving, hosted, yours };
}
