import { consumeStream } from '@/lib/planning/planEditsClient';
import type { SprintPlanReviewDto } from '@/lib/dto/aiSprintPlan';
import type { SprintAssignmentDelta } from '@/lib/ai/types';

// The browser-side transport for AI sprint planning (Subtask MOTIR-1750) — the
// three shipped MOTIR-918 routes plus the MOTIR-1750 review read.
//
// It deliberately does NOT introduce a second streaming client: the SSE frames
// are consumed through `planEditsClient`'s `consumeStream`, the same one every
// plan-edit job uses, so frame parsing / the `error` + `done` terminal contract /
// abort semantics have exactly one implementation. Only the URLs, the response
// shapes, and the error taxonomy differ, and those live here.

/** The `code`s the shipped routes return, each mapping to one drawn failure. */
export const SPRINT_PLANNING_DISABLED_CODE = 'SPRINT_PLANNING_DISABLED';
export const OUT_OF_CREDITS_CODE = 'MOTIR_AI_OUT_OF_CREDITS';

/**
 * A failed sprint-planning request.
 *
 * Unlike `PlanEditsClientError` this keeps the server's `detail` message, because
 * the invalid-packing failure the design draws QUOTES it ("MOTIR-1750 is blocked
 * by MOTIR-1749, but the packing schedules MOTIR-1749 no earlier") — a generic
 * "something went wrong" would strip the one thing that makes that state
 * actionable.
 */
export class SprintPlanClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: string | null,
  ) {
    super(detail ?? `Sprint planning request failed (${status})`);
    this.name = 'SprintPlanClientError';
  }
}

async function readProblem(res: Response): Promise<{ code: string | null; detail: string | null }> {
  try {
    const body = (await res.json()) as { code?: string; error?: string };
    return { code: body.code ?? null, detail: body.error ?? null };
  } catch {
    return { code: null, detail: null };
  }
}

async function fail(res: Response): Promise<never> {
  const { code, detail } = await readProblem(res);
  throw new SprintPlanClientError(res.status, code, detail);
}

/** POST /api/ai/plan/sprint — submit the packing job for the active project. */
export async function submitSprintPlanJob(signal?: AbortSignal): Promise<{ jobId: string }> {
  const res = await fetch('/api/ai/plan/sprint', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) await fail(res);
  return (await res.json()) as { jobId: string };
}

/** GET /api/ai/plan/sprint/:jobId/stream — the relayed job stream (SSE). */
export async function streamSprintPlanJob(
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  onFrame?: (event: string, data: unknown) => void,
): Promise<void> {
  return consumeStream(
    `/api/ai/plan/sprint/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
    onFrame,
  );
}

/** GET /api/ai/plan/sprint/:jobId/review — the proposal resolved for render. */
export async function fetchSprintPlanReview(
  jobId: string,
  signal?: AbortSignal,
): Promise<SprintPlanReviewDto> {
  const res = await fetch(`/api/ai/plan/sprint/${encodeURIComponent(jobId)}/review`, {
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) await fail(res);
  return (await res.json()) as SprintPlanReviewDto;
}

export interface ApproveSprintPlanResponse {
  sprints: Array<{ tempId: string; id: string; name: string; assignedCount: number }>;
  assigned: number;
}

/**
 * POST /api/ai/plan/sprint/approve — the ONLY write in this flow.
 *
 * The reviewed packing rides the body (`approvedDelta`) so what persists is
 * exactly what the human saw and approved; the server re-validates it from
 * scratch. Discard has no counterpart here on purpose — discarding is simply not
 * calling this.
 */
export async function approveSprintPlan(
  jobId: string,
  approvedDelta: SprintAssignmentDelta,
  signal?: AbortSignal,
): Promise<ApproveSprintPlanResponse> {
  const res = await fetch('/api/ai/plan/sprint/approve', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, approvedDelta }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) await fail(res);
  return (await res.json()) as ApproveSprintPlanResponse;
}
