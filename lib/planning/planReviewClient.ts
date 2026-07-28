import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanDto, PlanWithItemsDto, UpdateProposalInput } from '@/lib/dto/plans';

// Client reads/writes of the plan-detail substrate API (Subtask 7.4.5 /
// MOTIR-847). The plan-detail island fetches the review model (and POLLS it while
// `generating` for the live per-level reveal), then approves (materialize) or
// declines (drop) through the same substrate API — so no client component touches
// the service layer directly.
//
// It is also the ONE seam every AI-planning surface reviews and confirms through
// (MOTIR-1746/1747): the conversational rail, the `/items` expand/replan dock and
// the `/ready` expansion nudge all read a run's proposals from its Plan here and
// approve through `POST /api/plans/[id]/approve` → `materialize`. That is the
// engine's invariant made concrete — the plan engine adds Plan/PlanItems and ALL
// planning is the same, whoever pulled the trigger. The helpers those surfaces
// share on top of these calls (is there a pending proposal? what did an approve
// land? what does a failed decision mean?) live in `planReview.ts`.

export class PlanRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Plan request failed (${status})`);
    this.name = 'PlanRequestError';
  }
}

async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

/** Fetch the plan-detail review model. Throws `PlanRequestError` on a non-2xx. */
export async function fetchPlanReview(
  planId: string,
  signal?: AbortSignal,
): Promise<PlanReviewDto> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new PlanRequestError(res.status, await readError(res));
  return (await res.json()) as PlanReviewDto;
}

/** Approve (materialize) the plan. Throws `PlanRequestError` (409 = already
 *  decided by a concurrent reviewer). */
export async function approvePlanRequest(planId: string): Promise<PlanWithItemsDto> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/approve`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new PlanRequestError(res.status, await readError(res));
  return (await res.json()) as PlanWithItemsDto;
}

/** Decline (drop) the plan. Throws `PlanRequestError` on a non-2xx. */
export async function declinePlanRequest(planId: string): Promise<PlanDto> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/decline`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new PlanRequestError(res.status, await readError(res));
  return (await res.json()) as PlanDto;
}

/** Edit a proposed `add`'s fields (Subtask 7.21.6 / MOTIR-1370). Throws
 *  `PlanRequestError` — 409 when the plan is no longer `planned` (a concurrent
 *  reviewer decided), 422 on an invalid edit (e.g. an empty title). */
export async function updateProposalRequest(
  planId: string,
  planItemId: string,
  input: UpdateProposalInput,
): Promise<PlanWithItemsDto> {
  const res = await fetch(
    `/api/plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(planItemId)}`,
    {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) throw new PlanRequestError(res.status, await readError(res));
  return (await res.json()) as PlanWithItemsDto;
}
