import type { ProjectRepoName } from '@/lib/projectRepos/names';
import { resolveEffectiveRepoDomain } from '@/lib/projectRepos/effectiveDomain';
import { UnknownProjectRepoRefError } from './errors';
import {
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

// WHICH REPOSITORY an item belongs to, resolved only through the project's
// explicit `project_repository` association (MOTIR-4955). Organisation
// connectivity supplies candidates for linking and operational index facts; it
// is never a fallback authorization for authoring or dispatch. The pin domain
// includes planned rows, while the dispatch domain includes established rows.

/** The project row domains, adapted to the shapes dispatch consumes. */
async function resolveDomains(
  projectId: string,
  ctx: ServiceContext,
): Promise<{
  scope: 'project';
  dispatchable: ConnectedRepoName[];
  pinnable: ConnectedRepoName[];
  /** The same pinnable values with their project_repository row ids. */
  projectRows: ProjectRepoName[];
}> {
  const domain = await resolveEffectiveRepoDomain(projectId, ctx);
  return {
    scope: domain.scope,
    dispatchable: domain.dispatchable,
    pinnable: domain.pinnable,
    projectRows: domain.projectRows,
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
 * An empty project set accepts no non-empty name; clearing a pin still yields
 * empty refs and names. The two forms are never independently meaningful.
 */
export interface ResolvedRepoPins {
  refs: string[];
  names: string[];
  scope: 'project';
}

/**
 * The established project links an item in this project can be dispatched into.
 *
 * Exported for the surfaces that resolve several items against one domain and for
 * tests that assert the project boundary directly; a single item's dispatch should call
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
  const byName = new Map(projectRows.map((r) => [r.name.toLowerCase(), r.rowId]));
  const refs: string[] = [];
  for (const name of names) {
    const rowId = byName.get(name.toLowerCase());
    // Every accepted name came from a project row. A missing id would mean the
    // name and reference domains diverged, so fail closed instead of writing a
    // misaligned primary.
    if (rowId === undefined) return { refs: [], names, scope };
    refs.push(rowId);
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
  const rows = projectRows;
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
 * a name (and for tests that assert the project domain directly); this one
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
