import type { ProjectRepoRole } from '@/generated/prisma/client';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';
import { normalizeTargetRepo } from '@/lib/workItems/targetRepo';
import { isEstablishedState } from './vocabulary';

// ADR §5.3's three outcomes, as a PURE function of a project's repository set
// (Story MOTIR-1775 · MOTIR-1913) — "what repo name, if any, does this role mean?".
//
// Pure and separate from the service for the same reason `names.ts` is: the
// POLICY is the part that can be quietly wrong, and it is unit-testable against a
// hand-built set with no database, no transaction and no access gate. The service
// contributes the lock, the transaction and the write — not a second copy of the
// rule.
//
// It answers for the WHOLE set at once rather than one role at a time, because
// two of the three outcomes are properties of the set (a role's row count), not
// of a row.

/** What a role resolves to against a set. Only `resolved` names a repository. */
export type RepoRoleOutcome =
  /** Exactly one row carries the role AND it is established — `repoName` is set. */
  | 'resolved'
  /** Exactly one row carries the role, but it names no repository that exists
   *  (still `proposed` / `creating`, or `skipped` / `failed`, or its `GithubRepo`
   *  mirror is gone). ADR §5.3's "matches no established row → stays null". */
  | 'unestablished'
  /** MORE THAN ONE row carries the role (§1.2's repeated role) — §5.3's "never an
   *  arbitrary pick". */
  | 'ambiguous'
  /**
   * Exactly one row carries the role and it names a repository that EXISTS, but
   * that repository is ARCHIVED on the host (MOTIR-1959) — read-only, so no
   * branch and no pull request can be opened against it.
   *
   * A VALUE OF ITS OWN rather than a second `unestablished`, which is the whole
   * point: both refuse to resolve, and they refuse for opposite reasons. An
   * `unestablished` role has nothing yet and the fix is to establish it; an
   * `archived` role has a real repository whose owner made it read-only, and the
   * fix is on the host. Collapsing them would report "no repo for this role"
   * about a repository the user is looking straight at, which is the illegible
   * refusal `MOTIR-1956` was actually made of.
   */
  | 'archived';

export interface ResolvedRepoRole {
  role: ProjectRepoRole;
  outcome: RepoRoleOutcome;
  /** The repo NAME items of this role may be pinned to — non-null iff `resolved`. */
  repoName: string | null;
  /** EVERY row of the set carrying this role, in set order — the evidence behind
   *  the outcome, so an `ambiguous` verdict can name the rows that caused it
   *  instead of being an unexplained refusal. */
  rowIds: string[];
}

/**
 * What a SINGLE row resolves to — the outcome, and the name when there is one.
 *
 * The two rules `toProjectRepoNames` documents, applied per row:
 *
 * 1. **ESTABLISHED rows only.** A `proposed` / `creating` / `skipped` / `failed`
 *    row — and a `created` row whose mirror has since been deleted — names no
 *    checkout that exists, and pinning an item to it would send an agent's cwd
 *    somewhere that never appears.
 * 2. **The REALIZED repo's own name wins** over the row's authored `name`: the
 *    host's casing is what `work_item.targetRepo` stores and what the CLI keys
 *    `<root>/<name>` on, and the two legitimately differ once a repo is renamed
 *    on the host.
 *
 * Plus the LIVENESS rule (MOTIR-1959): an established row whose repository is
 * ARCHIVED resolves to `archived` and to NO name. Establishment is a fact about
 * the row (a repository was created or connected for it); liveness is a fact
 * about the repository, and it can flip long afterwards — so the two are read
 * separately and the name is withheld on either failure. Withholding it is what
 * makes the guard real: a pin is written from `repoName`, and a role that
 * resolved to a name would pin every item of that role to a repository no PR can
 * be opened against.
 *
 * Deliberately NOT `toProjectRepoNames` itself: that function additionally
 * DE-DUPLICATES the set case-insensitively by name, which is right for the
 * dispatch DOMAIN ("which names may be pinned?") and wrong here. Two rows of
 * DIFFERENT roles whose realized repos happen to share a bare name would collapse
 * to one entry there, and the dropped row's role would then read as
 * `unestablished` when its repository plainly exists. Resolution asks a per-row
 * question, so it reads the row.
 */
function resolveSingleRow(row: ProjectRepoWithRealized): {
  outcome: RepoRoleOutcome;
  repoName: string | null;
} {
  if (!isEstablishedState(row.state) || row.githubRepo === null) {
    return { outcome: 'unestablished', repoName: null };
  }
  const repoName = normalizeTargetRepo(row.githubRepo.name);
  if (repoName === null) return { outcome: 'unestablished', repoName: null };
  // Checked AFTER the name, so the archived verdict is only ever reached by a row
  // that genuinely names a repository — an archived row with an unusable name is
  // `unestablished`, which is the more basic problem and the one to report.
  if (row.githubRepo.archived) return { outcome: 'archived', repoName: null };
  return { outcome: 'resolved', repoName };
}

/**
 * Resolve EVERY role the set mentions, keyed by role.
 *
 * **Ambiguity is counted over ALL rows carrying the role, in any state — not just
 * the established ones.** ADR §5.3 phrases its first outcome as "exactly one
 * established row", and read literally that would let a set holding a `created`
 * web row beside a `skipped` web row resolve `web` to the created one. Two things
 * say it must not:
 *
 * - **It would be a guess of exactly the forbidden kind.** The user planned two
 *   distinct web repositories (§1.2) and the plan pinned items to "web"; nothing
 *   records WHICH of the two an item meant. Half of them belong in the row that
 *   was skipped, and pinning those to its sibling sends an agent into the wrong
 *   checkout — the outcome `docs/decisions/target-repo-attribution.md` §3 puts
 *   strictly below no answer at all.
 * - **It would make the answer depend on RUN ORDER.** This pass runs per row as
 *   each becomes established (the card's trigger), so a role counted over
 *   established rows only would resolve to row 1 while row 2 was still
 *   `creating`, pin every item to it, and then report `ambiguous` a second later
 *   when row 2 landed — with the pins already written. Counting rows makes the
 *   verdict a property of the SET, so it is identical no matter which row
 *   establishes first, or whether the pass runs once or ten times.
 *
 * A role with a single row therefore moves `unestablished → resolved` as that row
 * establishes, and moves again only if that repository is later ARCHIVED
 * (MOTIR-1959), which is a fact about the repository rather than about the set.
 *
 * ⚠️ **An ARCHIVED row beside a LIVE row of the same role is still `ambiguous`,
 * not `resolved` to the live one.** The count is over rows, in any state, for the
 * reason above — and archiving does not remove a row from the set any more than
 * skipping it does. Resolving to the survivor would be exactly the forbidden
 * guess: the user planned two repositories for this role, half the items belong
 * in the one that is now read-only, and nothing records which. `ambiguous` names
 * both rows and refuses; the user's own fix (remove or re-plan the archived row)
 * is what makes the role resolvable, and then it resolves to the row they chose
 * rather than the row Motir picked.
 */
export function resolveRepoRoles(
  rows: ProjectRepoWithRealized[],
): Map<ProjectRepoRole, ResolvedRepoRole> {
  const byRole = new Map<ProjectRepoRole, ProjectRepoWithRealized[]>();
  for (const row of rows) {
    const bucket = byRole.get(row.role);
    if (bucket) bucket.push(row);
    else byRole.set(row.role, [row]);
  }

  const resolved = new Map<ProjectRepoRole, ResolvedRepoRole>();
  for (const [role, roleRows] of byRole) {
    const rowIds = roleRows.map((r) => r.id);
    if (roleRows.length > 1) {
      resolved.set(role, { role, outcome: 'ambiguous', repoName: null, rowIds });
      continue;
    }
    const { outcome, repoName } = resolveSingleRow(roleRows[0]!);
    resolved.set(role, { role, outcome, repoName, rowIds });
  }
  return resolved;
}
