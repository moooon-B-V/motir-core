import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import {
  listConnectedRepoNames,
  matchAuthoredTargetRepo,
  normalizeTargetRepo,
  resolveDispatchRepo,
  type ConnectedRepoName,
  type ResolvedDispatchRepo,
} from './targetRepo';
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
}> {
  const domains = await projectRepoSetService.getRepoNameDomains(projectId, ctx);
  if (domains.hasSet) {
    return { scope: 'project', dispatchable: domains.dispatchable, pinnable: domains.pinnable };
  }
  const connected = await listConnectedRepoNames(ctx);
  return { scope: 'workspace', dispatchable: connected, pinnable: connected };
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
 * The dispatch repo for ONE item: the pin when it has one, else the project's
 * single repo when that is unambiguous, else `null` — with the clone URL and
 * default branch of whichever repo that resolved to (`null` when Motir does not
 * know them; see {@link ResolvedDispatchRepo}).
 *
 * This is what every dispatch surface calls, so `POST /api/ready/next`,
 * `next_ready`, `claim_next_ready` and `dispatch_prompt` can never route
 * differently.
 */
export async function resolveItemDispatchRepo(
  pinned: string | null,
  projectId: string,
  ctx: ServiceContext,
): Promise<ResolvedDispatchRepo | null> {
  return resolveDispatchRepo(pinned, await listDispatchRepoNames(projectId, ctx));
}
