import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type { PlanStatusDto } from '@/lib/dto/plans';

// The serializable view-model a Plans-list SESSION row binds to (MOTIR-6025,
// `design/ai-planning/design-notes.md` Part XIX §19.2). Built ON THE SERVER
// (`sessionRowView.ts`) from `PlanSessionRowDto`, so the row stays
// presentational and never re-derives a relative time — which would risk an
// SSR/CSR hydration mismatch.

export interface SessionRowView {
  id: string;
  origin: PlanSessionOriginDto;
  /** What was asked — the first `user` turn — or, with no turn, the latest
   *  plan's title. Empty when the session has neither. */
  title: string;
  /** The anchor set; empty = the whole project. */
  targetKeys: string[];
  /** Pre-formatted relative `lastActivityAt` ("12 minutes ago"). */
  activeLabel: string;
  /** Who started it; null on a cadence session and a departed member's. */
  startedByName: string | null;
  /** The latest plan — what the chip names and opens — or null (`No plan yet`). */
  latestPlan: { id: string; status: PlanStatusDto } | null;
  /** How many plans the session holds, the latest included. */
  planCount: number;
}
