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
    /**
     * The refused proposal and the server's sentence, when the refusal names one
     * (MOTIR-5418) — an approve refused by a folder deleted since the plan was
     * written carries `planItemId` and a message naming `folder:<id>`, which is
     * what lets the rail say which proposal rather than a generic error.
     */
    readonly detail: { planItemId: string | null; message: string | null } = {
      planItemId: null,
      message: null,
    },
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

async function readErrorDetail(
  res: Response,
): Promise<{ code: string | null; planItemId: string | null; message: string | null }> {
  try {
    const body = (await res.json()) as { code?: string; planItemId?: string; error?: string };
    return {
      code: body.code ?? null,
      planItemId: typeof body.planItemId === 'string' ? body.planItemId : null,
      message: typeof body.error === 'string' ? body.error : null,
    };
  } catch {
    return { code: null, planItemId: null, message: null };
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

/**
 * The press body (MOTIR-6038): the `stamp` the reader was shown — the review read's
 * `PlanReviewDto.gate.stamp` — handed back so the decide door can refuse a press made
 * against a version that has since moved. Null when the reader was shown no question
 * (a `generating` plan's discard); the server decides whether one was owed.
 */
function decisionInit(stamp: string | null | undefined): RequestInit {
  return {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ stamp: stamp ?? null }),
  };
}

/** Approve (materialize) the plan — decides its gate through the decide door with the
 *  stamp the reader was shown (MOTIR-6038). Throws `PlanRequestError` (409 = already
 *  decided, withdrawn, stale, held by a revision, or not decidable yet). */
export async function approvePlanRequest(
  planId: string,
  stamp?: string | null,
): Promise<PlanWithItemsDto> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/approve`, decisionInit(stamp));
  if (!res.ok) {
    const { code, planItemId, message } = await readErrorDetail(res);
    throw new PlanRequestError(res.status, code, { planItemId, message });
  }
  return (await res.json()) as PlanWithItemsDto;
}

/** Decline the plan — through its gate when it is asked, a plain discard of a
 *  `generating` / `stale` plan otherwise (MOTIR-6038). Throws `PlanRequestError`. */
export async function declinePlanRequest(planId: string, stamp?: string | null): Promise<PlanDto> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/decline`, decisionInit(stamp));
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

/**
 * ASK MOTIR TO CHANGE THIS PLAN (Story MOTIR-3595 · Subtask MOTIR-3601).
 *
 * The revision is a JOB: this returns as soon as it is DISPATCHED, and the change
 * lands later. The `planId` that comes back is the one that went in — the story's
 * first criterion, asserted server-side and echoed here so a caller that
 * persisted it can check.
 */
export async function revisePlanRequest(
  planId: string,
  prompt: string,
): Promise<{ jobId: string; planId: string }> {
  const res = await fetch('/api/ai/revise', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId, prompt }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    throw new PlanRequestError(res.status, body.code ?? 'REVISE_FAILED');
  }
  return (await res.json()) as { jobId: string; planId: string };
}
