import { projectsService } from '@/lib/services/projectsService';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';

/**
 * On an issue-key lookup MISS, work out whether `key` (e.g. "PROD-7") addresses
 * an issue under a RETIRED project key (Story 6.8 · Subtask 6.8.2). Returns the
 * CANONICAL identifier ("NIF-7") the caller should 308-redirect to, or `null`
 * when the key is not an old-key hit — i.e. a genuine 404. Old issue links keep
 * working after a project-key change: they permanent-redirect to the new key,
 * while the link TEXT is never rewritten (the verified Jira behaviour).
 *
 * The prefix is resolved through the SINGLE central alias-aware resolver
 * (`projectsService.resolveByKey`) — no alias query lives here. Only a `viaAlias`
 * hit redirects: a LIVE prefix means the issue genuinely doesn't exist under a
 * current key (→ 404), and `viaAlias` guarantees the canonical identifier
 * differs from the requested prefix, so the redirect can never loop. A missing /
 * cross-workspace / released-alias / browse-denied prefix yields `null` (404, no
 * existence leak — same shape as a live miss).
 */
export async function resolveAliasedIssueKey(
  key: string,
  ctx: WorkspaceContext,
): Promise<string | null> {
  // Identifiers are `<KEY>-<number>` and the key is 3–5 alnum (never
  // hyphenated), so split on the FIRST hyphen. No hyphen, or an empty side,
  // means this isn't an issue identifier we can re-key.
  const hyphen = key.indexOf('-');
  if (hyphen <= 0 || hyphen === key.length - 1) return null;
  const prefix = key.slice(0, hyphen);
  const number = key.slice(hyphen + 1);

  try {
    const { project, viaAlias } = await projectsService.resolveByKey(prefix, ctx);
    if (!viaAlias) return null;
    return `${project.identifier}-${number}`;
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof ProjectAccessDeniedError) {
      return null;
    }
    throw err;
  }
}
