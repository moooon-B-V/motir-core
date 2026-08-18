import type { PlanAuthorSourceDto, PlanOriginDto, PlanStatusDto } from '@/lib/dto/plans';

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
  /** WHY the plan was started — `cadence` is the auto-plan watcher, which is the
   *  one state with no requester to name (`design/ai-planning/design-notes.md`
   *  Part III §3). */
  origin: PlanOriginDto;
  /** WHICH motir-ai job produced it, or null. The row reads this — NOT
   *  `authorSource === 'native'` — to know Motir wrote the plan: the generator
   *  path deliberately records no author (MOTIR-2996), so every Motir generation
   *  carries a null `authorSource`. */
  sourceJobId: string | null;
  /** WHO ASKED — resolved to a display NAME server-side, batched across the page
   *  (`planRowView.ts`), because the DTO carries only an id and the row must stay
   *  presentational. Null on a cadence plan and on any plan predating the
   *  column. */
  createdByName: string | null;
  /** WHO WROTE it. `mcp` + a harness is an agent; the Motir case is read off
   *  `sourceJobId` above. */
  authorSource: PlanAuthorSourceDto | null;
  authorHarness: string | null;
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
