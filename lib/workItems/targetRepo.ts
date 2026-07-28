import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { UnknownTargetRepoError } from './errors';
import type { ServiceContext } from './serviceContext';

// Per-item REPO ATTRIBUTION (Story 7.9 · MOTIR-1804) — the rebuilt producer half
// of the cancelled 7.7.3 dispatch-payload contract, and the piece the CLI has
// been waiting on: `motir link add <repo> <path>` (7.9.1) already maps a repo
// NAME to a checkout path, but nothing told it which NAME an item belongs to.
//
// Three jobs, kept OUT of `workItemsService` so the (coverage-gated) service
// stays a thin caller and this policy is unit-testable without a work item:
//
//   1. NORMALIZE the authored value — trim, and accept the `owner/name` ref form
//      as an alias for the bare `name` the CLI keys on.
//   2. VALIDATE it against the workspace's CONNECTED repo set (the 7.10.3
//      installation mirror). One repo registry, not two: a pin that names a repo
//      Motir isn't connected to is a typo, and a typed error is far better than
//      a dispatch that sends an agent to a directory that will never exist.
//   3. RESOLVE the dispatch value — the explicit pin when there is one, else the
//      workspace's SINGLE connected repo (the unambiguous default), else null.
//
// Why resolution happens at DISPATCH and not at CREATE: the connected set moves
// (repos get connected and disconnected). Baking today's default into every row
// would freeze a GUESS as if it were a decision, and the two would be
// indistinguishable afterwards. Keeping the column to explicit pins only means
// the payload always reflects current reality, and `null` on the wire honestly
// means "Motir does not know" — which is exactly the signal the CLI needs to
// fall back to its workspace-root rule (never a guess).
//
// Composition mirrors `lib/ai/codeContext.ts`: this opens its OWN workspace
// context (the `github_repo` RLS policies are workspace-keyed and the work-item
// service does not run inside one), so every caller MUST invoke it OUTSIDE its
// write transaction — never nested inside a `db.$transaction`.

/** The bare repo NAME the CLI keys checkouts on (`motir-core`), plus the
 *  `owner/name` ref it came from — enough to explain an ambiguity in an error. */
export interface ConnectedRepoName {
  /** The bare repo name — the value stored in `work_item.targetRepo`. */
  name: string;
  /** `owner/name`, the display form used in error messages. */
  repoRef: string;
}

/**
 * The workspace's connected repos, as the names a `targetRepo` may reference.
 * De-duplicated by NAME (two owners can expose the same repo name; the CLI
 * checks both out at `<root>/<name>`, so they are one checkout identity as far
 * as dispatch is concerned — first by the repository's stable owner/name order
 * wins). Empty when the workspace has no connection, which makes every non-null
 * pin invalid — the honest outcome: attribution is meaningless with no repos.
 */
export async function listConnectedRepoNames(ctx: ServiceContext): Promise<ConnectedRepoName[]> {
  const repos = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
    (tx) => githubRepoRepository.listByWorkspace(ctx.workspaceId, tx),
  );
  const byName = new Map<string, ConnectedRepoName>();
  for (const repo of repos) {
    if (!byName.has(repo.name)) {
      byName.set(repo.name, { name: repo.name, repoRef: `${repo.owner}/${repo.name}` });
    }
  }
  return [...byName.values()];
}

/**
 * Normalize an authored `targetRepo` to the bare repo NAME the column stores.
 *
 * Accepts either the bare name (`motir-core`) or the `owner/name` ref form
 * (`moooon/motir-core`) — the latter is what `resolveCodeContext` and the GitHub
 * surfaces display, so an agent that copies a repo from there gets the same
 * result as one that types the short name. A blank / whitespace-only string
 * normalizes to `null` (an explicit clear), so a caller never has to distinguish
 * "" from null.
 */
export function normalizeTargetRepo(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const slash = trimmed.lastIndexOf('/');
  const name = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  return name.length === 0 ? null : name;
}

/**
 * Normalize + VALIDATE an authored `targetRepo` against the workspace's
 * connected repo set, returning the value to store (`null` clears the pin).
 *
 * Matching is case-insensitive — git-host repo names are, and a pin that differs
 * only in case names the same checkout. The STORED value is the connected repo's
 * own casing, so the column and `.motir.json` can never disagree on the
 * directory name. An unknown name throws `UnknownTargetRepoError` (422 at the
 * route layer, a self-correctable tool error over MCP) naming the known set.
 *
 * MUST be called OUTSIDE the caller's write transaction — it opens its own
 * workspace context (see the module header).
 */
export async function resolveAuthoredTargetRepo(
  value: string | null | undefined,
  ctx: ServiceContext,
): Promise<string | null> {
  const name = normalizeTargetRepo(value);
  if (name === null) return null;
  const connected = await listConnectedRepoNames(ctx);
  const match = connected.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    throw new UnknownTargetRepoError(
      name,
      connected.map((r) => r.repoRef),
    );
  }
  return match.name;
}

/**
 * The DISPATCH value: the explicit pin when the item carries one, else the
 * workspace's single connected repo when that is unambiguous, else `null`.
 *
 * "Exactly one connected repo" is the only safe default — with two or more there
 * is no non-arbitrary choice, and a wrong repo sends the agent's cwd into the
 * wrong checkout, which is worse than no answer at all (the CLI's documented
 * fallback for `null` is the link root, where a human notices immediately).
 */
export function resolveDispatchTargetRepo(
  pinned: string | null,
  connected: ConnectedRepoName[],
): string | null {
  if (pinned !== null) return pinned;
  return connected.length === 1 ? connected[0]!.name : null;
}
