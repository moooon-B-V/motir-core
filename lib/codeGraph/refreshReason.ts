/**
 * WHY A CODE GRAPH IS BEHIND (Story MOTIR-1754 · MOTIR-2105).
 *
 * The state says WHETHER (`lib/codeGraph/indexState.ts`); the drift says HOW FAR
 * (`lib/codeGraph/driftCount.ts`); this says WHY, and it is the one a person
 * needs to know whether to wait.
 *
 * ⚠️ THE VOCABULARY LIVES HERE, BESIDE THE OTHER TWO DERIVATIONS, rather than in
 * `lib/ai/codeContext.ts` where it was declared. It is a fact about a code
 * graph, not about a planning envelope — and the DTO a UI reads cannot import it
 * from `lib/ai/` without inverting the layering. `lib/ai/codeContext.ts`
 * re-exports it, so every existing import site is unchanged.
 */
export type CodeRefreshReason =
  /** A refresh was enqueued by THIS session start. */
  | 'refresh_enqueued'
  /** A refresh is already in flight (or held by the shipped debounce). */
  | 'refresh_pending'
  /** Connected, but no graph has ever been built. */
  | 'never_indexed'
  /** The host cannot be indexed at all — GitLab today (MOTIR-4609). */
  | 'provider_unsupported'
  /** Refreshes are failing. */
  | 'refresh_failing'
  /** Refreshes are paused. ⚠️ NEVER the internal cause (MOTIR-4541). */
  | 'paused';

/**
 * The reasons a refresh will NOT resolve itself — the ones where waiting is the
 * wrong advice and saying "check back later" would be a lie.
 *
 * ⚠️ THIS IS THE DISTINCTION MOTIR-2105 EXISTS FOR. A stale graph whose refresh
 * dead-lettered and a stale graph with a refresh queued behind it look identical
 * on every surface Motir had: both say `stale`, both keep answering every tool
 * call, and only one of them is ever going to get better. The incident that
 * produced this card is the proof — 35 dead-letters over 48 hours, nobody
 * noticed, and three days later the rate was unchanged.
 */
export const TERMINAL_REFRESH_REASONS: readonly CodeRefreshReason[] = [
  'refresh_failing',
  'paused',
  'provider_unsupported',
];

/** Does this reason mean the graph will keep drifting until somebody acts? */
export function refreshIsStuck(reason: CodeRefreshReason | undefined): boolean {
  return reason !== undefined && TERMINAL_REFRESH_REASONS.includes(reason);
}

/**
 * ⚠️ IS THIS REPOSITORY'S REFRESH DEAD? (MOTIR-2105.)
 *
 * `GithubRepo.indexingRunId` is a POINTER to the run that last claimed the
 * repository, and `indexState.ts` already resolves it against the ledger to tell
 * a genuinely-running index from a crashed one. This asks the OTHER question of
 * the same pointer: did that run reach a terminal state it will never leave?
 *
 * ⚠️ WHY THE POINTER AND NOT THE RUN'S OWN OUTPUT. The index job writes
 * `output.repoRef` only ON SUCCESS, so a `failed` or `abandoned` row cannot say
 * which repository it belonged to — the ledger genuinely does not know. The
 * pointer is the only attribution that exists, which is why the running-state
 * read uses it too.
 *
 * ⚠️ `failed` AND `abandoned` ARE BOTH TERMINAL AND ARE NOT THE SAME FACT. The
 * schema keeps them apart deliberately: "the handler threw" has a stack trace to
 * show and "nothing ever came back" does not. For THIS question they are one
 * answer — the refresh is not coming — and the surface says so without claiming
 * to know which.
 *
 * `false` when the pointer is null (nothing ever claimed it) or when the run it
 * names is not terminal — a running one is `indexing`, and a succeeded one has
 * already cleared. Never inferred from drift: a repository can be far behind
 * with a perfectly healthy pipeline that has simply not run yet.
 */
export function deriveRefreshFailing(input: {
  indexingRunId: string | null;
  terminalRunIds: ReadonlySet<string>;
}): boolean {
  if (input.indexingRunId === null) return false;
  return input.terminalRunIds.has(input.indexingRunId);
}
