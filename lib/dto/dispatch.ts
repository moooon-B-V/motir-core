// DTOs for the DISPATCH-PROMPT surface (Story 7.9 · MOTIR-1802) — the canonical,
// server-generated prompt the BYOK CLI hands to a coding agent, and the routing
// facts it needs alongside it.
//
// This is the seam MOTIR-881 (`motir next --print`) consumes: the CLI never
// assembles its own prompt grammar, so the prompt text crosses the wire ready to
// paste. Keeping the grammar server-side is what makes it uniform across every
// agent harness (Claude Code / Codex / opencode / …), versionable with the
// product, and the single place the Epic-9 enrichment injections will land.

/**
 * WHICH git workflow the prompt's `GIT WORKFLOW` section instructs — chosen
 * SERVER-SIDE from the item's inherited session branch, never selectable by the
 * caller (a client that could pick its own lineage could strand an integrated
 * dependency chain on two branches):
 *
 * - `per_item_pr` — no session lineage: branch from `origin/main`, open ONE pull
 *   request for this item, stop at the PR.
 * - `session_lineage` — this item's dependencies are integrated on a session
 *   branch awaiting ONE human review, so the work branches from and integrates
 *   back into that branch and is reported with `mark_integrated`.
 */
export type DispatchWorkflowMode = 'per_item_pr' | 'session_lineage';

/**
 * The `dispatch_prompt` payload: the assembled prompt plus the facts the CLI
 * routes on before it runs the agent.
 *
 * The prompt is a PURE FUNCTION of server state — two calls for an unchanged
 * item return byte-identical `prompt` text (no timestamps, no randomness, no
 * LLM), which is what makes the consumer's "byte-identical" contract testable.
 */
export interface DispatchPromptDto {
  /** The `PROD-<n>` identifier the prompt was assembled for. */
  key: string;
  /** The full multi-section prompt text, ready to hand to a coding agent. */
  prompt: string;
  /**
   * WHICH repo to run this in — the RESOLVED bare repo name (the item's explicit
   * pin, else the workspace's single connected repo), or `null` when Motir
   * cannot say. Identical resolution to `ReadyItemDispatchDto.targetRepo`
   * (MOTIR-1804), so the two dispatch surfaces can never route differently.
   */
  targetRepo: string | null;
  /**
   * Which `GIT WORKFLOW` variant the prompt carries — see
   * {@link DispatchWorkflowMode}. A MANUAL item (`type: manual` / `executor:
   * human`) renders NO `GIT WORKFLOW` section at all and always reports
   * `per_item_pr` with a null branch: it has no branch and no pull request, so
   * routing it onto a git lineage would be a lie the CLI would act on.
   */
  workflowMode: DispatchWorkflowMode;
  /** The session branch the prompt instructs, or `null` in `per_item_pr` mode. */
  sessionBranch: string | null;
}
