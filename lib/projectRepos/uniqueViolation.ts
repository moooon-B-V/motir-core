import { uniqueViolationConstraints } from '@/lib/prisma/uniqueViolation';

/**
 * Which of `project_repository`'s two unique indexes a `P2002` violated.
 *
 *   - `claim`        — `@@unique([projectId, githubRepoId])`: this project's set
 *                      already holds that repository. Renaming cannot fix it.
 *   - `name`         — `@@unique([projectId, name])`: the name is taken.
 *   - `unclassified` — a `P2002` that names no constraint either index matches.
 *
 * ⚠️ BOTH SERVICES THAT WRITE THE SET ASK THIS ONE FUNCTION (MOTIR-5273). Until
 * then each carried its own copy of this classification: MOTIR-4833 repaired
 * `organizationRepoService`'s, and `projectRepoSetService`'s kept reading the
 * absent `meta.target`, so its claim arm was unreachable and a lost race on the
 * realize path re-threw the raw Prisma error — a 500 out of a function whose own
 * contract said a raw P2002 never escapes. One classifier is what stops a fix from
 * reaching one copy and not the other.
 *
 * ⚠️ BOTH ARMS ARE POSITIVE, AND THE REMAINDER HAS ITS OWN NAME. A violation this
 * cannot attribute is `unclassified` — never silently one of the two, because
 * each of those tells the caller to do something specific and one of them is
 * wrong half the time.
 *
 * Returns `null` when `err` is not a `P2002` at all.
 */
export type ProjectRepoUniqueViolation = 'claim' | 'name' | 'unclassified';

export function classifyProjectRepoUniqueViolation(
  err: unknown,
): ProjectRepoUniqueViolation | null {
  if ((err as { code?: unknown } | null)?.code !== 'P2002') return null;
  const constraints = uniqueViolationConstraints(err);
  if (constraints === null) return 'unclassified';
  if (namesClaimConstraint(constraints)) return 'claim';
  if (namesNameConstraint(constraints)) return 'name';
  return 'unclassified';
}

/** `@@unique([projectId, githubRepoId])`, as the column list or the index name. */
function namesClaimConstraint(constraints: string[]): boolean {
  // One test covers both shapes: the column is `github_repo_id`, and the index
  // name `project_repository_project_id_github_repo_id_key` contains it.
  return constraints.some((c) => c.includes('github_repo_id'));
}

/** `@@unique([projectId, name])`, as the column list or the index name. */
function namesNameConstraint(constraints: string[]): boolean {
  // Two tests, because the index name does NOT contain the bare column: it is
  // `project_repository_project_id_name_key`. Asked AFTER the claim constraint,
  // so the ordering never has to arbitrate between them.
  return constraints.some((c) => c === 'name' || c.endsWith('_name_key'));
}
