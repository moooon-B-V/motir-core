import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import type { ProjectRepoName } from '@/lib/projectRepos/names';
import { UnknownProjectRepoRefError } from './errors';
import {
  listConnectedRepoNames,
  matchAuthoredTargetRepo,
  matchAuthoredTargetRepos,
  normalizeTargetRepo,
  resolveDispatchRepo,
  type ConnectedRepoName,
  type ResolvedDispatchRepo,
} from './targetRepo';
import type { Prisma } from '@/generated/prisma/client';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { ServiceContext } from './serviceContext';

// WHICH REPO an item belongs to, resolved against the PROJECT (Story MOTIR-1775 ·
// MOTIR-1783). This module owns exactly one thing the shipped policy in
// `targetRepo.ts` deliberately does not: the SCOPE the domain comes from.
//
// MOTIR-1804 shipped the pin, and resolved it against "the workspace's connected
// repos" — which was the only registry that existed then, and which quietly
// assumes one project per workspace's repos. MOTIR-1780 gave a project its own
// repository SET, so the domain becomes:
//
//   the PROJECT's set          ← whenever the project has one
//   the workspace's connected repos ← only for a project that has NO set
//
// The second rung is the compatibility path the ADR names explicitly
// (`docs/decisions/project-repository-set.md`, "Consequences"): every project
// that predates the table — including Motir's own — has an empty set, and
// dispatch must keep routing them exactly as it did yesterday. It is a fallback
// for a MISSING set, never a second guess layered under a real one: a project
// that HAS planned its repositories is answered by that plan alone, even when the
// plan resolves to nothing.
//
// Two domains, one snapshot (see `projectRepoSetService.getRepoNameDomains`):
//
//   * DISPATCH domain — established, realized rows. It names a checkout that must
//     exist right now, so a plan-only row is not in it.
//   * PIN domain — every row. Authoring records a decision about work that has
//     not run yet, and the plan names repositories before it creates them, so a
//     pin at `proposed` is ordinary, not an error. What validation still catches
//     is the typo and the sibling project's repo.
//
// Nothing here opens a transaction of its own beyond the reads it delegates, but
// every entry point DOES (the set read is workspace-context-scoped for RLS, and
// the workspace fallback opens its own too) — so, exactly like `targetRepo.ts`,
// every caller MUST invoke these OUTSIDE its write transaction.

/**
 * The repo-name DOMAINS for a project, with the scope ladder already applied:
 * the project's own set when it has one, else the workspace's connected repos.
 */
async function resolveDomains(
  projectId: string,
  ctx: ServiceContext,
): Promise<{
  scope: 'project' | 'workspace';
  dispatchable: ConnectedRepoName[];
  pinnable: ConnectedRepoName[];
  /**
   * The project's own PIN rows when the project HAS a set, else `null`.
   *
   * The same values `pinnable` carries, at their un-widened type — a
   * `ProjectRepoName` knows the `project_repository` row its name came from, and a
   * `ConnectedRepoName` cannot. The reference model needs that row id, and the
   * `null` is not a nuisance to code around: it IS the compatibility rung. A
   * project with no set has no rows to point at, so its pins stay NAMES in
   * `work_item.targetRepo`, exactly as they are today (ADR
   * `work-item-repository-set.md` "Amendment 2026-08-18" §A7).
   */
  projectRows: ProjectRepoName[] | null;
}> {
  const domains = await projectRepoSetService.getRepoNameDomains(projectId, ctx);
  if (domains.hasSet) {
    return {
      scope: 'project',
      dispatchable: domains.dispatchable,
      pinnable: domains.pinnable,
      projectRows: domains.pinnable,
    };
  }
  const connected = await listConnectedRepoNames(ctx);
  return {
    scope: 'workspace',
    dispatchable: connected,
    pinnable: connected,
    projectRows: null,
  };
}

/**
 * A validated repository pin, in BOTH representations the product carries during
 * ADR §A7's expand → contract window.
 *
 * `refs` is the AUTHORED state — the `project_repository` row ids, ordered, element
 * 0 the primary. `names` is the derived projection the legacy columns and every
 * published shape still hold, produced by the SAME resolution so the two can never
 * describe different repositories.
 *
 * `refs` is EMPTY for a project that has no repository set: there is nothing to
 * point at, and `names` alone is that project's answer (§A7's compatibility rung).
 * The two are therefore never independently meaningful — a caller writes both or
 * neither, from one call.
 */
export interface ResolvedRepoPins {
  refs: string[];
  names: string[];
  scope: 'project' | 'workspace';
}

/**
 * The repos an item in this project can be DISPATCHED into — the project's
 * established set, else (no set) the workspace's connected repos.
 *
 * Exported for the surfaces that resolve several items against one domain and for
 * tests that assert the ladder directly; a single item's dispatch should call
 * {@link resolveItemDispatchRepo}, which pairs this with the pin.
 */
export async function listDispatchRepoNames(
  projectId: string,
  ctx: ServiceContext,
): Promise<ConnectedRepoName[]> {
  return (await resolveDomains(projectId, ctx)).dispatchable;
}

/**
 * Normalize + VALIDATE an authored `targetRepo` for an item in this project,
 * returning the value to store (`null` clears the pin).
 *
 * The project-scoped counterpart of `resolveAuthoredTargetRepo`, and the one a
 * work-item write calls. A pin naming a repo that belongs to a SIBLING project of
 * the same workspace is rejected here with `UnknownTargetRepoError` — under the
 * old workspace-wide validation it was accepted, and the item then dispatched an
 * agent into a checkout that has nothing to do with its project.
 *
 * MUST be called OUTSIDE the caller's write transaction (see the module header).
 */
export async function resolveAuthoredTargetRepoInProject(
  value: string | null | undefined,
  projectId: string,
  ctx: ServiceContext,
): Promise<string | null> {
  // A cleared / absent pin needs no domain at all — and reading one would make an
  // unpin fail on a project whose set the actor may not browse.
  if (normalizeTargetRepo(value) === null) return null;
  const { scope, pinnable } = await resolveDomains(projectId, ctx);
  return matchAuthoredTargetRepo(value, pinnable, scope);
}

/**
 * The SET counterpart of {@link resolveAuthoredTargetRepoInProject}, under the
 * REFERENCE model: validate an authored repository set given as NAMES, and return
 * BOTH the `project_repository` row ids it resolves to and the names themselves
 * (Story MOTIR-2732 · MOTIR-3039).
 *
 * It REPLACES `resolveAuthoredTargetReposInProject`, which returned the names
 * alone. That function had exactly one caller — the work-item write path — and
 * every caller now needs the row ids beside the names, so keeping a names-only
 * twin would be a second resolution of one question and the way the two forms
 * start to disagree.
 *
 * ⚠️ It DELEGATES the whole name policy to `matchAuthoredTargetRepos` rather than
 * re-implementing it, for the reason that function's own comment gives: the set
 * path and the single path must normalize, match, case-fold, order and collapse
 * duplicates identically, or a card's repository means one thing when it was
 * pinned and another when it was listed. Everything added here is the row lookup —
 * and it cannot fail, because `toProjectRepoPinNames` de-duplicates the domain by
 * name case-insensitively, so a matched name names exactly one row.
 *
 * `refs` is EMPTY when the project has NO repository set, and that is not a
 * degraded answer: such a project's pins are validated against the workspace's
 * connected repositories and stored as names, exactly as they are today (ADR
 * `work-item-repository-set.md` "Amendment 2026-08-18" §A7's compatibility rung).
 *
 * MUST be called OUTSIDE the caller's write transaction (see the module header).
 */
export async function resolveAuthoredRepoPinsInProject(
  values: readonly (string | null | undefined)[] | null | undefined,
  projectId: string,
  ctx: ServiceContext,
): Promise<ResolvedRepoPins> {
  if (!values || values.every((v) => normalizeTargetRepo(v) === null)) {
    return { refs: [], names: [], scope: 'project' };
  }
  const { scope, pinnable, projectRows } = await resolveDomains(projectId, ctx);
  const names = matchAuthoredTargetRepos(values, pinnable, scope);
  if (projectRows === null) return { refs: [], names, scope };
  const byName = new Map(projectRows.map((r) => [r.name.toLowerCase(), r.rowId]));
  const refs: string[] = [];
  for (const name of names) {
    const rowId = byName.get(name.toLowerCase());
    if (rowId !== undefined) refs.push(rowId);
  }
  return { refs, names, scope };
}

/**
 * Validate an authored repository set given as `project_repository` ROW IDS —
 * the reference-native write shape (ADR "Amendment 2026-08-18" §A4) — and return
 * the ids alongside the NAMES they resolve to.
 *
 * Order is preserved and element 0 is the primary; a repeated id COLLAPSES keeping
 * the first occurrence, exactly as a repeated name does on the other path. An id
 * that is not one of THIS project's rows throws {@link UnknownProjectRepoRefError}
 * on the first one, all-or-nothing, for the same reason the name path refuses a
 * partially-accepted set: storing part of it records a decision the author never
 * wrote.
 *
 * A project with NO repository set has no row a caller could legitimately name, so
 * every id is unknown there and the error's empty-set message says so — which is
 * the honest answer, and the reason such a project's callers keep sending names.
 *
 * MUST be called OUTSIDE the caller's write transaction (see the module header).
 */
export async function resolveAuthoredRepoRefsInProject(
  refs: readonly (string | null | undefined)[] | null | undefined,
  projectId: string,
  ctx: ServiceContext,
): Promise<ResolvedRepoPins> {
  const wanted = (refs ?? []).map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean);
  if (wanted.length === 0) return { refs: [], names: [], scope: 'project' };
  const { scope, projectRows } = await resolveDomains(projectId, ctx);
  const rows = projectRows ?? [];
  const byId = new Map(rows.map((r) => [r.rowId, r]));
  const known = rows.map((r) => `${r.rowId} (${r.name})`);
  const outRefs: string[] = [];
  const outNames: string[] = [];
  const seen = new Set<string>();
  for (const ref of wanted) {
    const row = byId.get(ref);
    if (row === undefined) throw new UnknownProjectRepoRefError(ref, known);
    if (seen.has(ref)) continue;
    seen.add(ref);
    outRefs.push(ref);
    outNames.push(row.name);
  }
  return { refs: outRefs, names: outNames, scope };
}

/**
 * The dispatch repo for ONE item: the pin when it has one, else the project's
 * single repo when that is unambiguous, else `null` — with the clone URL and
 * default branch of whichever repo that resolved to (`null` when Motir does not
 * know them; see {@link ResolvedDispatchRepo}).
 *
 * This is what every dispatch surface calls, so `POST /api/ready/next`,
 * `next_ready`, `claim_next_ready` and `dispatch_prompt` can never route
 * differently.
 */
/**
 * The PRIMARY repository NAME of an item, resolved from its REFERENCES — with the
 * legacy column as the last rung (Story MOTIR-2732 · MOTIR-3040, ADR
 * "Amendment 2026-08-18" §A7).
 *
 * ⚠️ This exists because MOTIR-1913's resolution pass RETIRED. That pass used to
 * write `work_item.targetRepo` when a role's row became established, and dispatch
 * read the column it wrote. With the pass gone nothing fills that column, so a
 * card pinned before its repositories existed would dispatch to NOTHING — the
 * exact end-to-end path MOTIR-3040's AC 2 asserts, and the regression this
 * function is the fix for.
 *
 * The reference is now the pin, and the NAME is derived from it on read (§A4's
 * rule: the realized repository's own name, else the row's authored intent). The
 * column survives only as the compatibility rung — a project with NO repository
 * set has no row to reference, so its pins are still names and still answer here.
 */
export async function resolveItemDispatchPin(
  item: { id: string; targetRepo: string | null },
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  const refs = await workItemRepoRepository.listByWorkItem(item.id, tx);
  const primary = refs[0];
  if (primary !== undefined) {
    const resolved = normalizeTargetRepo(
      primary.projectRepo.githubRepo?.name ?? primary.projectRepo.name,
    );
    if (resolved !== null) return resolved;
  }
  return item.targetRepo;
}

export async function resolveItemDispatchRepo(
  pinned: string | null,
  projectId: string,
  ctx: ServiceContext,
): Promise<ResolvedDispatchRepo | null> {
  return resolveDispatchRepo(pinned, await listDispatchRepoNames(projectId, ctx));
}

/**
 * The dispatch repo for ONE item, resolving its PIN from the item's references
 * first (MOTIR-3040).
 *
 * The overload every dispatch surface should call. `resolveItemDispatchRepo`
 * above takes a pinned NAME and is kept for the callers that genuinely have only
 * a name (and for the tests that assert the three-rung ladder directly); this one
 * takes the ITEM, so a surface cannot accidentally read a column that the
 * reference model no longer fills.
 */
export async function resolveDispatchRepoForItem(
  item: { id: string; targetRepo: string | null; projectId: string },
  ctx: ServiceContext,
): Promise<ResolvedDispatchRepo | null> {
  const pinned = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    resolveItemDispatchPin(item, tx),
  );
  return resolveItemDispatchRepo(pinned, item.projectId, ctx);
}
