// Per-PR CI state for the work-item Development surface (Story 7.10 ·
// MOTIR-1579), derived from a PR's recorded check rows. Distinct from the
// work item's aggregate `ciState` (MOTIR-894): that signal is denormalized,
// terminal-only (passing | failing), and flipped by the webhook; THIS one is
// computed at read time per PR and includes the non-terminal 'running' (from
// the pending rows the webhook records since MOTIR-1579).
//
// The derivation window is the PR's LATEST recorded commit sha — the sha of
// its newest-created check row. `createdAt` (not `updatedAt`) orders shas by
// first sighting: a re-run on an OLD sha refreshes that row's `updatedAt` but
// never outranks a newer push's rows.
//
// ⚠️ AND WITHIN THAT SHA, ONLY THE RUNS THAT HAVE NOT BEEN REPLACED
// (MOTIR-3209). Two workflow runs at one commit is ordinary — `cancel-in-progress`
// makes it so — and the cancelled one's rows must not decide anything. That rule
// is `liveCheckRows`, and it is SHARED with the feedback comment's own
// derivation deliberately: two opinions about one commit is what MOTIR-2946
// removed.

import { liveCheckRows, type SuiteScopedCheckRow } from './checkSuites';

export type PrCiState = 'passing' | 'failing' | 'running' | null;

export interface PrCheckRunSlice extends SuiteScopedCheckRow {
  commitSha: string;
  conclusion: string;
  createdAt: Date;
}

/**
 * Precedence at the latest sha: any `failure` → 'failing'; else any `pending`
 * → 'running'; else any `success` → 'passing'. No rows at all — or none of
 * the three known conclusions — → null (absence of CI is NOT a state; the
 * surface renders no CI pill).
 */
export function derivePrCiState(checkRuns: PrCheckRunSlice[]): PrCiState {
  const atHead = liveRowsAtLatestSha(checkRuns);
  if (atHead.length === 0) return null;
  if (atHead.some((r) => r.conclusion === 'failure')) return 'failing';
  if (atHead.some((r) => r.conclusion === 'pending')) return 'running';
  if (atHead.some((r) => r.conclusion === 'success')) return 'passing';
  return null;
}

/**
 * The rows this derivation actually reads: the LATEST recorded sha's rows, minus
 * every run a later run replaced.
 *
 * Extracted from `derivePrCiState` (MOTIR-4199) rather than re-derived beside
 * it, because the check-set reconcile has to name the SAME window this verdict
 * is formed over — a reconcile that filled in a different sha's set would leave
 * the two disagreeing about which commit is being judged, which is the class of
 * defect `liveCheckRows`' header says was removed. Empty when there are no rows
 * at all.
 */
export function liveRowsAtLatestSha<T extends PrCheckRunSlice>(checkRuns: T[]): T[] {
  if (checkRuns.length === 0) return [];
  const newest = checkRuns.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return liveCheckRows(checkRuns.filter((r) => r.commitSha === newest.commitSha));
}
