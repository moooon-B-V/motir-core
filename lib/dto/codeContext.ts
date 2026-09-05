// DTOs for the CODE-CONTEXT surface (Story MOTIR-1754 · MOTIR-1767) — the answer
// to "what code can the planner see, and how current is it?".
//
// motir-core holds no AI tables: index freshness comes over the 7.1 boundary from
// motir-ai's `CodeRepo` rows, and the default-branch head comes from motir-core's
// own `GithubRepo.lastPushSha` (MOTIR-1766). This is the joined, browser-facing
// shape both surfaces of the story render — `/planning`'s code-context strip and
// `/code-health`'s connect affordance. Dates stay ISO strings.

/**
 * The per-repo verdict — a TOTAL function over four states, not a boolean.
 *
 * ⚠️ `stale` and `indexing` are DIFFERENT states and only one of them is moving.
 * A stale repository may sit stale for ever: a refresh can be paused, failing, or
 * impossible for the provider entirely. Only `indexing` may be rendered with
 * wait-and-return language (`design/code-context/design-notes.md` §6.1).
 */
export type CodeRepoVerdict = 'current' | 'stale' | 'indexing' | 'never_indexed';

export interface CodeContextRepoDTO {
  /** `owner/name`, the same ref motir-ai keys its coordination row on. */
  repoRef: string;
  provider: string;
  verdict: CodeRepoVerdict;
  /** The commit the graph was built at, or null when there is no graph. */
  indexedCommitSha: string | null;
  indexedAt: string | null;
  codegraphVersion: string | null;
  /**
   * The default branch's head as of the last push Motir saw (MOTIR-1766).
   *
   * ⚠️ NULL means UNKNOWN, never "behind". A repository connected before the head
   * column shipped, or one whose provider does not record a head, has no evidence
   * either way — and `verdict` resolves that to `current`, never to `stale`.
   */
  headSha: string | null;
  /**
   * How far the graph is behind, in COMMITS — the number the surface leads with.
   *
   * ⚠️ ALWAYS NULL TODAY. Distinguishing `stale` from `current` needs only a sha
   * inequality; COUNTING the commits between two shas needs a commit-graph read
   * neither repository holds, and MOTIR-1766's standing constraint is that no
   * provider round-trip may happen on a page render. The producer is its own card.
   *
   * `null` is a first-class, RENDERED answer, not a gap: the surface reads
   * "behind by an unknown number of commits" and its chip reads "Behind"
   * (`design/code-context/design-notes.md` §5 and panel D3).
   */
  commitsBehind: number | null;
}

export interface CodeContextDTO {
  /**
   * Would the planner receive `context.code` at all? Exactly
   * `resolveCodeContext(...) !== undefined` — i.e. the workspace has an
   * installation with at least one connected repository. This is the flag behind
   * the "planning without code context" state, and it is deliberately the SAME
   * predicate the job envelope is built from rather than a second one.
   */
  hasCodeContext: boolean;
  repos: CodeContextRepoDTO[];
  /**
   * Has anybody reported implementing work on this project? The trigger for the
   * connect affordance, and the reason it is not a day-one nag.
   */
  hasImplementedWork: boolean;
  /**
   * True when the freshness read could not be obtained from motir-ai. Every repo
   * then carries its connection facts with a `never_indexed` verdict and null
   * freshness, and the surface still renders — an AI-side failure must never 500
   * the planning workspace.
   */
  freshnessUnavailable: boolean;
}
