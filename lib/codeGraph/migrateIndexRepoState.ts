// THE MIGRATE WIZARD'S PER-REPO INDEX STATE, AND ITS INDEX-STEP EXIT
// (Story MOTIR-8246 · MOTIR-8768).
//
// Onboarding no longer stops at the index step: a run leaves `index` as soon as
// the repository it connected is in its connected set, whatever state that
// repository's index is in, and the wizard shows the index's progress where it
// does not block. Two questions follow, and each has ONE answer here:
//
//   * which of `queued | indexing | indexed | failed` a connected repository is
//     in — read by the index-status read (and so by the indicator), and
//   * whether a run may leave `index`, and whether the graph is BUILT — read by
//     both `INDEX.checkExit` and `runIndexSweep`, which must never disagree.
//
// ⚠️ A DIFFERENT AXIS FROM `indexState.ts`. That module's four states
// (`never | indexing | indexed | stale`) are about a graph's freshness against
// the default branch; these are about an index the person is waiting on, and
// `failed` is the one state that one cannot name. The INPUTS are the same
// pointer-plus-ledger facts `codeContextService.readFacts` resolves — a
// `running`, `failed` or `abandoned` ledger row carries no `output.repoRef`, so
// `GithubRepo.indexingRunId` is the only attribution they have.

/** What the wizard says about one connected repository's index. */
export type MigrateIndexRepoState =
  /** Connected, no graph, and nothing has claimed it yet — enqueued, waiting
   *  behind others, or paused for catch-up. */
  | 'queued'
  /** The repository's claimed run is still `running` in the ledger. */
  | 'indexing'
  /** A succeeded index run carries this repository's ref. */
  | 'indexed'
  /** No graph, and nothing is coming without an action: the claimed run ended
   *  `failed` or `abandoned`, or the repository was refused for size. */
  | 'failed';

/** The facts the derivation reads, each already resolved against the ledger by
 *  the caller (never against the pointer column alone). */
export interface MigrateIndexRepoFacts {
  /** A succeeded `system.code-graph-index` run carries this repository's ref. */
  hasSucceededIndex: boolean;
  /** `indexingRunId` names a run that is still `running`. */
  hasRunningIndex: boolean;
  /** `indexingRunId` names a `failed` or `abandoned` run (`deriveRefreshFailing`). */
  refreshFailing: boolean;
  /** `indexRefusedAt` is set — the index refused the repository for its size. */
  refusedForSize: boolean;
}

/**
 * The one derivation. A built graph wins over everything (a later failed refresh
 * does not un-build it); a running claim beats a stale size refusal, because the
 * run in flight is the newer fact; otherwise a dead claim or a size refusal is
 * `failed`, and anything else is `queued`.
 *
 * The pointer names ONE run, so `hasRunningIndex` and `refreshFailing` cannot
 * both be true from the same pointer — a crashed run's pointer resolves to an
 * `abandoned` row, which reads `failed`, never `indexing`.
 */
export function deriveMigrateIndexRepoState(facts: MigrateIndexRepoFacts): MigrateIndexRepoState {
  if (facts.hasSucceededIndex) return 'indexed';
  if (facts.hasRunningIndex) return 'indexing';
  if (facts.refreshFailing || facts.refusedForSize) return 'failed';
  return 'queued';
}

/** The index step's verdict for one run. */
export type MigrateIndexExit =
  | { ready: false }
  /** `graphBuilt` is true only when the run's repository has a succeeded index —
   *  it is the ONLY case that may set `codeGraphReady`. */
  | { ready: true; graphBuilt: boolean };

/**
 * MAY THIS RUN LEAVE `index`? The one predicate `INDEX.checkExit` and
 * `runIndexSweep` both answer from.
 *
 * Ready as soon as the run's `connectedRepoRef` names a repository in its
 * connected set: an index for it exists in some state (the connect step enqueued
 * it), and the step no longer waits for that index to finish. `graphBuilt`
 * keeps `codeGraphReady`'s meaning — "the graph is built" — so generation still
 * refuses to draft from an unread codebase (MOTIR-933).
 *
 * A run whose `codeGraphReady` was already observed is ready with the graph
 * built, exactly as before this change.
 */
export function decideMigrateIndexExit(input: {
  codeGraphReady: boolean;
  connectedRepoRef: string | null;
  connectedRefs: ReadonlySet<string>;
  succeededRefs: ReadonlySet<string>;
}): MigrateIndexExit {
  if (input.codeGraphReady) return { ready: true, graphBuilt: true };
  const ref = input.connectedRepoRef;
  if (!ref || !input.connectedRefs.has(ref)) return { ready: false };
  return { ready: true, graphBuilt: input.succeededRefs.has(ref) };
}
