import type { PlanStatusDto } from '@/lib/dto/plans';

// The serializable view-model the Plans LIST row binds to (Subtask 7.21.1 /
// MOTIR-1338). Built ON THE SERVER (`planRowView.ts`) from the `PlanDto` +
// staleness verdict, so the client list/row components stay presentational —
// they never touch the service layer (the access-path/4-layer rule) and never
// re-derive a relative time (which would risk an SSR/CSR hydration mismatch).

/** Which lifecycle timestamp the row's relative-time reads, so the row labels it
 *  with the matching verb (`planned 2h ago` / `approved …` / `declined …`). */
export type PlanWhenKey = 'createdAt' | 'plannedAt' | 'approvedAt' | 'declinedAt';

export interface PlanRowView {
  id: string;
  status: PlanStatusDto;
  /** The resolved display title — the plan's summary/idea, falling back to its
   *  title, then a placeholder for an un-named (still generating) plan. */
  title: string;
  itemCount: number;
  /** Number of proposed items flagged out-of-date (MOTIR-1340). Non-zero only
   *  for a `planned` plan whose tree context drifted; drives the stale pill. */
  staleCount: number;
  whenKey: PlanWhenKey;
  /** Pre-formatted relative time for `whenKey` (e.g. "2 hours ago"), computed
   *  server-side against the request's shared `now` so it is hydration-stable. */
  whenLabel: string;
}
