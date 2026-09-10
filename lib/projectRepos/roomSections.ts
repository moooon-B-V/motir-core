import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';

// THE ROOM'S SECTIONS, split by ONE rule (MOTIR-3126; RE-SCOPED TO THE PROJECT'S
// LINKS BY MOTIR-4954) — `/settings/project/repositories` renders the
// repositories LINKED TO THIS PROJECT, split into the ones picked from the
// organisation and the ones Motir created, and this module is the only place that
// decides which side a link falls on.
//
// ⚠️ PURE, AND CLIENT-SAFE ON PURPOSE. The split is applied twice — once on the
// server, seeding the room, and once in the client island, which re-reads the
// establish view after every mutation and on the takeover poll. Two
// implementations of "which section is this row in?" is exactly how a repository
// comes to appear in both at once, so there is one, and it imports nothing that
// would drag a workspace context into a bundle.
//
// ── ⚠️ THERE IS ONE REGISTRY HERE NOW, NOT TWO (MOTIR-4998) ──────────────────
// This module used to carry a SECOND registry beside the project's links: the
// repositories the scope ladder LAYERED into a project holding no
// `project_repository` row of its own. Three exported helpers existed to classify
// that list, and **nothing produces it any more** — MOTIR-4955 retired the
// workspace rung itself (`lib/projectRepos/effectiveDomain.ts` returns
// `connected: []`, a literal) and MOTIR-4954 stopped this page drawing it. Their
// last two production callers went with those cards, four minutes apart on
// 2026-09-10; this card removed the helpers, which is why the header above no
// longer describes a two-registry room.
//
// ⚠️ WHAT THE DELETION HAD TO PRESERVE, AND WHERE IT WENT. One of the three was
// also a load-bearing half of a CROSS-SURFACE guarantee (bug MOTIR-4867): the
// organisation inventory and this room had to sort a repository into *the
// organisation's* or *Motir's* the same way, and
// `tests/projectRepos/hostOwnershipAgreement.test.ts` pinned the two answers
// against each other. **The room no longer asks that question — but it was never
// the only asker.** `lib/git/hostOwnership.ts` names three, and the other two are
// live: the inventory (`lib/mappers/organizationRepoMappers.ts`) and the CI
// meter's §5.1 gate (`lib/ciMetering/config.ts`). That test now pins THOSE two,
// over the same predicate, so MOTIR-4867's property survives its first consumer
// rather than being retired alongside it. Its header carries the reasoning.

/**
 * ONE ROW OF THE ORGANISATION SECTION.
 *
 * ⚠️ IT IS A ONE-MEMBER UNION NOW (MOTIR-4954), and it is kept as a union rather
 * than flattened to `ProjectRepoDto` deliberately. It used to carry a second
 * arm — a `domain` entry, a repository the LADDER layered into this project with
 * no `project_repository` row of its own — and the whole point of that card is
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
 * ⚠️ THE DUPLICATE WAS FIXED BY REMOVING ITS CAUSE, NOT BY A TIGHTER DEDUP. The
 * server de-duplicated the layered list against the set before rendering it, and
 * the surviving twin came from the ISLAND's post-mutation recompute, deduping
 * against a `rowsRef` that did not yet hold the row just added. A hardened dedup
 * would be dead code guarding a list that no longer exists — with the domain half
 * gone there is nothing left to de-duplicate AGAINST, so the duplicate cannot
 * recur.
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
 * dispatch.
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
 * This function used to SEED `yours` with the layered repositories the ladder
 * supplied — on the reasoning that the user owns them, Motir never bills their CI
 * and there is nothing to move. All three clauses are true and the count was
 * still wrong for this header, because the header sits above a list of the
 * PROJECT's repositories: it reported `0 moving · 0 hosted by Motir · 6 yours` on
 * a project holding **no links at all** (§18.2, observed). A number above a list
 * must count the things in that list.
 *
 * ⚠️ SO THE `connected` AND `hostOwner` PARAMETERS ARE GONE, NOT DEFAULTED. The
 * only reason this function needed to know who hosts a layered repository was to
 * subtract Motir's own from that seed (bug MOTIR-4867); with no seed there is
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
