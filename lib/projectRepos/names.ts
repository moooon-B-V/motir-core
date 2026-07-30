import type { ProjectRepoRole } from '@prisma/client';
import { normalizeTargetRepo, type ConnectedRepoName } from '@/lib/workItems/targetRepo';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';
import { isEstablishedState } from './vocabulary';

// The project-scoped counterpart of `listConnectedRepoNames` (Story MOTIR-1775 ·
// MOTIR-1780) — the repo NAMES a `work_item.targetRepo` may reference when the
// pin is resolved against the PROJECT's set instead of "the workspace's connected
// repos".
//
// Pure and separate from the service so the policy ("which rows even have a name
// a dispatch can use, and in what spelling?") is unit-testable without a DB, and
// so MOTIR-1783 / MOTIR-1784 / MOTIR-1884 consume ONE implementation rather than
// re-deriving it three times.
//
// The whole point is that a pin validated against the PROJECT's set and a pin
// validated against the WORKSPACE's connected set agree on spelling. That is not
// a promise made in a comment: this module calls the very same
// `normalizeTargetRepo` `resolveAuthoredTargetRepo` calls, and its result type
// EXTENDS `ConnectedRepoName`, so it drops straight into
// `resolveDispatchTargetRepo` with no adapter.

/**
 * One resolvable repo name from a project's set. Extends {@link ConnectedRepoName}
 * (so it is directly usable wherever the shipped workspace-scoped resolution is),
 * and adds the set-row context ADR §5.3 needs: a role that matches MORE than one
 * row must resolve to `null` rather than to an arbitrary row, which a caller can
 * only detect if it knows which row each name came from.
 */
export interface ProjectRepoName extends ConnectedRepoName {
  /** The `project_repository` row this name belongs to. */
  rowId: string;
  role: ProjectRepoRole;
  /** The row's free-form label — what distinguishes two rows of a repeated role. */
  label: string | null;
}

/**
 * The names a dispatch may be pinned to, in set order (primary first).
 *
 * Two rules, both load-bearing:
 *
 * 1. **ESTABLISHED rows only.** A `proposed` / `creating` / `skipped` / `failed`
 *    row names no checkout that exists, and neither does a `created` row whose
 *    `GithubRepo` mirror has since been deleted. Pinning an item to one would send
 *    an agent's cwd into a directory that will never exist — strictly worse than
 *    no answer (`docs/decisions/target-repo-attribution.md` §3). ADR §5.3's "the
 *    role matches no established row → `targetRepo` stays null" is exactly this
 *    list coming back without that role.
 *
 * 2. **The REALIZED repo's own name wins**, not the row's authored `name`. The
 *    host's casing is what `work_item.targetRepo` stores and what the CLI keys
 *    `<root>/<name>` on, and the two can legitimately differ once someone renames
 *    the repo on the host. Preferring the authored intent there would hand out a
 *    name no checkout answers to.
 *
 * De-duplicated by name, case-insensitively, first-in-set-order winning — the same
 * rule (and the same reason) as `listConnectedRepoNames`: two names that differ
 * only in case are one checkout identity as far as dispatch is concerned.
 */
export function toProjectRepoNames(rows: ProjectRepoWithRealized[]): ProjectRepoName[] {
  const byName = new Map<string, ProjectRepoName>();
  for (const row of rows) {
    if (!isEstablishedState(row.state) || row.githubRepo === null) continue;
    // The same normalization the authored-pin path applies, so a pin validated
    // here and one validated against the workspace agree on spelling.
    const name = normalizeTargetRepo(row.githubRepo.name);
    if (name === null) continue;
    const key = name.toLowerCase();
    if (byName.has(key)) continue;
    byName.set(key, {
      name,
      repoRef: `${row.githubRepo.owner}/${row.githubRepo.name}`,
      rowId: row.id,
      role: row.role,
      label: row.label,
    });
  }
  return [...byName.values()];
}
