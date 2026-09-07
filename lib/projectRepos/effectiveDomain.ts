import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { listConnectedRepoNames, type ConnectedRepoName } from '@/lib/workItems/targetRepo';
import { projectHasItsOwnCode } from './ownCode';
import type { ProjectRepoName } from './names';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// "WHICH REPOSITORIES DOES THIS PROJECT HAVE?" — ONE answer, for the resolver AND
// for the surfaces that render it (MOTIR-3086 · MOTIR-3126).
//
// ── Why this module exists ──────────────────────────────────────────────────
// MOTIR-3086 layered the two registries — the project's own `project_repository`
// SET and the workspace's CONNECTED repositories — into a ladder, and it did so
// inside `lib/workItems/dispatchRepo.ts`'s PRIVATE `resolveDomains`. Dispatch was
// the only caller that existed, so a private helper was the right size then.
//
// It stopped being the right size the moment a surface had to answer the same
// question: `/settings/project/repositories` reads `project_repository` and
// nothing else, so on Motir's own project — five connected repositories, an empty
// set — it renders "This project has no repositories yet" beside five repos that
// are indexed and pinnable right now (MOTIR-3126). The resolver and the room
// disagreed because there was only ever one place the ladder was written down,
// and a page could not reach it.
//
// So the ladder moved HERE, `resolveDomains` became a thin adapter over it, and a
// server component can call it. It sits in `lib/projectRepos/` rather than beside
// dispatch because it is a fact about the PROJECT, not about dispatching — the
// same reason `ownCode.ts` sits here.
//
// ── The ladder, unchanged ───────────────────────────────────────────────────
//   no set                             → the workspace's connected repositories
//   a set, project born in Motir       → the set ALONE
//   a set, project arrived WITH code   → the set FIRST, connected repos UNDER it
//
// The third rung's predicate is `projectHasItsOwnCode` — the project's
// `migrate_onboarding` run names a connected repository (ADR
// `docs/decisions/project-repository-set.md`, amendment 2026-08-19). The reason
// the rung is conditioned rather than unconditional is in `dispatchRepo.ts`'s
// module header, which is still where that history belongs.
//
// ── What this adds beyond what dispatch needed ──────────────────────────────
// The two registries SEPARATELY, alongside the union. Dispatch wants one list of
// names and does not care which table a name came from; a person looking at the
// room cares a great deal, because a Motir-hosted repository can be MOVED to
// their own GitHub and one they already own cannot. A surface handed only the
// union would have to re-derive the split — which is the duplication this module
// exists to end, one level up.
//
// ⚠️ Every entry point below opens its own transaction (the set read is
// workspace-context-scoped for RLS, and the connected read opens its own), so —
// exactly like `targetRepo.ts` and `dispatchRepo.ts` — every caller MUST invoke
// this OUTSIDE its write transaction.

/**
 * De-duplicate a merged domain by NAME, case-insensitively, FIRST occurrence
 * winning — the same rule (and the same reason) `listConnectedRepoNames` and
 * `toProjectRepoNames` each apply within their own list: two names differing only
 * in case are one checkout identity as far as dispatch is concerned.
 *
 * Order is MEANINGFUL (element 0 is the primary a set-less pin resolves to), so
 * the SET goes first and the workspace rung follows: a repository the project
 * planned outranks one it merely inherited from the installation, and a repo named
 * by both is answered by its set row, which is the entry that knows its `rowId`.
 */
export function mergeDomainsByName(
  first: readonly ConnectedRepoName[],
  second: readonly ConnectedRepoName[],
): ConnectedRepoName[] {
  const byName = new Map<string, ConnectedRepoName>();
  for (const entry of [...first, ...second]) {
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, entry);
  }
  return [...byName.values()];
}

/**
 * THE LADDER'S RUNG SELECTOR, AS A PURE PREDICATE — does this project's domain
 * LAYER the workspace's connected repositories at all? (MOTIR-4802.)
 *
 * The three rungs in the module header collapse to one boolean, and this is the
 * one place it is written:
 *
 *   no set                            → LAYERS (the connected registry is the
 *                                        whole domain)
 *   a set, project born in Motir      → does NOT layer (the set answers alone)
 *   a set, project arrived WITH code  → LAYERS (the set first, connected under)
 *
 * ⚠️ IT IS PURE, AND THE CALLER SUPPLIES THE FACTS — the same shape
 * `matchAuthoredTargetRepo` has, and for the same reason. A caller resolving ONE
 * project reads them one at a time ({@link resolveEffectiveRepoDomain} below); a
 * caller answering the INVERSE question — *which projects use this repository?*,
 * the organisation inventory's `Used by N projects` — has to gather them in bulk
 * for a whole organisation, and a rung it re-derived from its own two reads would
 * be a THIRD definition of the ladder. That re-derivation against the raw table
 * is the defect this module was extracted to end (MOTIR-3126) and the one that
 * reappeared one surface over (MOTIR-4802); a predicate both shapes can reach is
 * what stops it reappearing a third time.
 */
export function layersConnectedRepos(facts: { hasSet: boolean; hasOwnCode: boolean }): boolean {
  return !facts.hasSet || facts.hasOwnCode;
}

/** One project's ladder inputs, as {@link projectsLayeringConnectedRepos} takes them. */
export interface ProjectLadderFacts {
  projectId: string;
  /** Whether the project has a repository SET at all (rows, established or not). */
  hasSet: boolean;
  /** Whether the project arrived WITH code of its own (`projectHasItsOwnCode`). */
  hasOwnCode: boolean;
}

/**
 * THE LADDER, INVERTED AND IN BULK — which of these projects layer their
 * workspace's connected repositories into their domain (MOTIR-4802).
 *
 * The set membership is what the inverse question needs: a repository connected
 * in workspace W is used by every project of W in this set, PLUS whatever
 * `project_repository` links name explicitly. Pure, so the caller decides how to
 * gather the facts cheaply — the organisation inventory reads both in two bulk
 * reads rather than resolving N project-scoped domains.
 */
export function projectsLayeringConnectedRepos(facts: readonly ProjectLadderFacts[]): Set<string> {
  const layering = new Set<string>();
  for (const project of facts) {
    if (layersConnectedRepos(project)) layering.add(project.projectId);
  }
  return layering;
}

/**
 * A project's repository domain, with the scope ladder already applied — the two
 * registries separately AND merged.
 */
export interface EffectiveRepoDomain {
  /**
   * Whose repositories these are, for the wording of an
   * `UnknownTargetRepoError`. `'project'` whenever the project has a set of its
   * own — including when the workspace rung is layered under it, because the
   * domain is then still exactly this project's repositories (the ones it planned
   * plus the ones it arrived with).
   */
  scope: 'project' | 'workspace';
  /** Whether the project has a repository SET at all (rows, established or not). */
  hasSet: boolean;
  /**
   * Whether the ladder LAYERS the workspace-connected registry into this
   * project's domain at all — true for a set-less project (where it is the whole
   * domain) and for a project that arrived with code of its own; false for a
   * project born in Motir, which its set answers completely.
   *
   * ⚠️ NOT `connected.length > 0`. A project whose domain includes the rung but
   * whose workspace has nothing connected YET still layers it — the difference is
   * "this list is empty right now" versus "this project has no such list", and a
   * surface that conflates them either hides a section that should be there or
   * asserts an absence the project never had.
   */
  layersConnected: boolean;
  /**
   * The WORKSPACE-connected repositories, **as layered** — EMPTY when the ladder
   * answers with the set alone.
   *
   * ⚠️ Empty here means "not part of this project's domain", NOT "the workspace
   * has none". A surface must not re-read the workspace to second-guess it: that
   * re-derivation is precisely the second definition this module removes.
   */
  connected: ConnectedRepoName[];
  /** The repos an item may be DISPATCHED into — established rows only, merged. */
  dispatchable: ConnectedRepoName[];
  /** The repos a pin may be AUTHORED against — every row, merged. */
  pinnable: ConnectedRepoName[];
  /**
   * The project's own PIN rows when the project HAS a set, else `null`.
   *
   * The same values `pinnable` carries for the set's half, at their un-widened
   * type — a `ProjectRepoName` knows the `project_repository` row its name came
   * from, and a `ConnectedRepoName` cannot. The reference model needs that row id,
   * and the `null` is not a nuisance to code around: it IS the compatibility rung.
   * A project with no set has no rows to point at, so its pins stay NAMES in
   * `work_item.targetRepo` (ADR `work-item-repository-set.md` "Amendment
   * 2026-08-18" §A7).
   */
  projectRows: ProjectRepoName[] | null;
}

/**
 * Resolve a project's effective repository domain.
 *
 * The reads are SEQUENCED, not parallelised, and deliberately: the second
 * question is only asked when its answer can matter. A set-less project needs no
 * onboarding-run read (the workspace rung is already its whole domain), and a
 * project answered by its set alone needs no connected-repository read at all.
 */
export async function resolveEffectiveRepoDomain(
  projectId: string,
  ctx: ServiceContext,
): Promise<EffectiveRepoDomain> {
  const domains = await projectRepoSetService.getRepoNameDomains(projectId, ctx);
  if (!domains.hasSet) {
    // `layersConnectedRepos({ hasSet: false, … })` is true for EITHER value of
    // `hasOwnCode`, which is why no onboarding read is owed on this rung — the
    // sequencing above is that fact, not an optimisation layered over it.
    const connected = await listConnectedRepoNames(ctx);
    return {
      scope: 'workspace',
      hasSet: false,
      layersConnected: true,
      connected,
      dispatchable: connected,
      pinnable: connected,
      projectRows: null,
    };
  }
  // ⚠️ `hasSet` is NOT AN ALL-OR-NOTHING SWITCH (MOTIR-3086, and
  // `getRepoNameDomains`' own doc says so). It selects between "the set ALONE"
  // and "the set FIRST, the workspace under it" — never between the two
  // registries — so no row a project gains can SUBTRACT a repository from its
  // domain.
  const hasOwnCode = await projectHasItsOwnCode(projectId, ctx);
  if (!layersConnectedRepos({ hasSet: true, hasOwnCode })) {
    return {
      scope: 'project',
      hasSet: true,
      layersConnected: false,
      connected: [],
      dispatchable: domains.dispatchable,
      pinnable: domains.pinnable,
      projectRows: domains.pinnable,
    };
  }
  const connected = await listConnectedRepoNames(ctx);
  return {
    // Still `'project'`: the domain IS this project's repositories — the ones it
    // planned plus the ones it arrived with — so `UnknownTargetRepoError`'s
    // project-scoped wording ("This project's repositories: …") stays true, and
    // the workspace-scoped wording would now be the misleading one.
    scope: 'project',
    hasSet: true,
    layersConnected: true,
    connected,
    dispatchable: mergeDomainsByName(domains.dispatchable, connected),
    pinnable: mergeDomainsByName(domains.pinnable, connected),
    // The ROWS are still only the set's — the union adds no `project_repository`
    // row and must not pretend otherwise. What that costs is handled where refs
    // are built, in `resolveAuthoredRepoPinsInProject`.
    projectRows: domains.pinnable,
  };
}
