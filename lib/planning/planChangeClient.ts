import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import type {
  ContextualPlanResultDto,
  PlanChangeSessionDto,
  PlanChangeSubmitResultDto,
} from '@/lib/dto/planChange';

// Client reads/writes for the plan-change CONVERSATION seam (Story 7.30 ·
// MOTIR-1728's routes), consumed by the conversational rail (MOTIR-1730). No
// client component calls the service layer — every call here is an HTTP hop to
// the shipped `/api/ai/plan-change/session*` endpoints.
//
// The JOB half is deliberately NOT re-implemented: a submitted conversation
// returns an ordinary `augment` job id, which the rail streams + approves through
// the ALREADY-SHIPPED `planEditsClient` helpers (`streamAugmentJob`,
// `fetchJobResult`, `approvePlanDelta`). This module owns only the three session
// calls, and reuses `PlanEditsClientError` so a caller branches on one error type
// (its `isOutOfCredits` covers the 402 the submit path can raise).

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' } as const;

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as T;
}

/** Open the active project's conversation, or RESUME the existing one. Idempotent
 *  (one thread per project) — the rail calls it on mount, and the response carries
 *  the full ordered thread, so a reopened workspace continues where it stopped. */
export async function openPlanChangeSession(signal?: AbortSignal): Promise<PlanChangeSessionDto> {
  return post<PlanChangeSessionDto>('/api/ai/plan-change/session', undefined, signal);
}

/** Append ONE turn. Appending ACCUMULATES; it does not submit. */
export async function appendPlanChangeTurn(
  body: string,
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto> {
  return post<PlanChangeSessionDto>('/api/ai/plan-change/session/turns', { body }, signal);
}

/** Submit the conversation's ACCUMULATED intent — every user turn in order, not
 *  just the newest one. Returns the shipped `augment` job to stream + approve. */
export async function submitPlanChange(signal?: AbortSignal): Promise<PlanChangeSubmitResultDto> {
  return post<PlanChangeSubmitResultDto>('/api/ai/plan-change/session/submit', undefined, signal);
}

// ─── The ITEM-ANCHORED half — the MOTIR-909 contextual-planning endpoints ─────
//
// The per-item entrance (MOTIR-910) rides the SAME conversation substrate,
// addressed by its anchor set instead of by the project. The shapes differ in one
// way worth naming: the project thread appends and submits in two calls, while
// the anchored endpoint does BOTH in one (it resolves + view-gates the anchors
// first, so splitting it would gate twice for one turn).

const anchorPath = (anchorId: string) => `/api/work-items/${encodeURIComponent(anchorId)}/ai/plan`;

/** RESUME the item's thread on mount. `null` when the item was never planned —
 *  a read, so looking at the entrance never writes a session row. */
export async function resumeContextualSession(
  anchorId: string,
  signal?: AbortSignal,
): Promise<PlanChangeSessionDto | null> {
  const res = await fetch(anchorPath(anchorId), {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  const body = (await res.json()) as { session: PlanChangeSessionDto | null };
  return body.session ?? null;
}

/** Append the turn to the item's thread AND submit the accumulated intent — one
 *  call (the MOTIR-909 contract). The Re-plan "reason" IS this prompt. */
export async function submitContextualPlan(
  anchorId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<ContextualPlanResultDto> {
  return post<ContextualPlanResultDto>(anchorPath(anchorId), { prompt }, signal);
}

/** Re-send the item thread's ACCUMULATED intent after a failed run, appending
 *  NOTHING — the conversation continues rather than restarting. */
export async function resubmitContextualPlan(
  anchorId: string,
  signal?: AbortSignal,
): Promise<ContextualPlanResultDto> {
  return post<ContextualPlanResultDto>(anchorPath(anchorId), { resubmit: true }, signal);
}
