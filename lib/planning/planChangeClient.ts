import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

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

/**
 * What a submit RESPONSE looks like to the browser. It mirrors the server's
 * `PlanChangeSubmitResultDto` with ONE deliberate difference: `planId` — the
 * `generating` Plan the job's proposals append into (MOTIR-1743/1745) — is
 * OPTIONAL here, exactly as `planEditsClient`'s `PlanEditSubmitResponse` types
 * it. It is an additive echo, so a caller must not depend on it: an E2E stub, a
 * hand-rolled fixture, or a pre-1745 response carries only `jobId`. Read it
 * defensively; the server DTO stays required, since the service always has one.
 */
export interface PlanChangeSubmitResponse {
  jobId: string;
  planId?: string;
  session: PlanChangeSessionDto;
}

/** The anchored submit's response — the above plus the thread's own id, which the
 *  anchored caller needs because it did not open the session in a separate call. */
export interface ContextualPlanResponse extends PlanChangeSubmitResponse {
  sessionId: string;
}

/** The anchored RESUME's response. `session` is `null` for an item never planned;
 *  `planId` names the thread's still-undecided proposal, and is absent whenever
 *  there is nothing pending to confirm — same defensive optionality as above. */
export interface ContextualSessionResumeResponse {
  session: PlanChangeSessionDto | null;
  planId?: string | null;
}

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
export async function submitPlanChange(signal?: AbortSignal): Promise<PlanChangeSubmitResponse> {
  return post<PlanChangeSubmitResponse>('/api/ai/plan-change/session/submit', undefined, signal);
}

// ─── The ITEM-ANCHORED half — the MOTIR-909 contextual-planning endpoints ─────
//
// The per-item entrance (MOTIR-910) rides the SAME conversation substrate,
// addressed by its anchor set instead of by the project. The shapes differ in one
// way worth naming: the project thread appends and submits in two calls, while
// the anchored endpoint does BOTH in one (it resolves + view-gates the anchors
// first, so splitting it would gate twice for one turn).

// MULTI-TARGET (MOTIR-1491): the anchor set is the PRIMARY anchor (the path
// item) plus the ADDITIONAL ones the `@`-mention picker inserted, by identifier.
// The route has accepted `targetKeys` on all three verbs since MOTIR-909 — these
// helpers simply carry them, so the same set that resumes a thread also submits
// and resubmits to it. Omitted / empty is exactly the single-anchor entrance.

const anchorPath = (anchorId: string) => `/api/work-items/${encodeURIComponent(anchorId)}/ai/plan`;

/** The additional anchors, OMITTED when there are none — so a single-anchor
 *  request stays byte-identical to the entrance's (MOTIR-910) and the route's
 *  `undefined` default does the rest. */
function extra(targetKeys: readonly string[]): { targetKeys?: string[] } {
  return targetKeys.length > 0 ? { targetKeys: [...targetKeys] } : {};
}

/** The additional anchors as the GET's repeated `?targetKey=` params. */
function anchorQuery(targetKeys: readonly string[]): string {
  if (targetKeys.length === 0) return '';
  const params = new URLSearchParams();
  for (const key of targetKeys) params.append('targetKey', key);
  return `?${params.toString()}`;
}

/** RESUME the item's thread on mount. A null `session` means the item was never
 *  planned — a read, so looking at the entrance never writes a session row.
 *
 *  Returns the ENVELOPE rather than the bare session (MOTIR-1745): a resumed
 *  thread may have a proposal still awaiting confirmation, and its `planId` is
 *  what lets the rail address that Plan. Both fields are normalized to `null` so
 *  a response predating the field reads the same as one with nothing pending. */
export async function resumeContextualSession(
  anchorId: string,
  targetKeys: readonly string[] = [],
  signal?: AbortSignal,
): Promise<ContextualSessionResumeResponse> {
  const res = await fetch(`${anchorPath(anchorId)}${anchorQuery(targetKeys)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  const body = (await res.json()) as ContextualSessionResumeResponse;
  return { session: body.session ?? null, planId: body.planId ?? null };
}

/** Append the turn to the item's thread AND submit the accumulated intent — one
 *  call (the MOTIR-909 contract). The Re-plan "reason" IS this prompt. */
export async function submitContextualPlan(
  anchorId: string,
  prompt: string,
  targetKeys: readonly string[] = [],
  signal?: AbortSignal,
): Promise<ContextualPlanResponse> {
  return post<ContextualPlanResponse>(
    anchorPath(anchorId),
    { prompt, ...extra(targetKeys) },
    signal,
  );
}

/** Re-send the item thread's ACCUMULATED intent after a failed run, appending
 *  NOTHING — the conversation continues rather than restarting. */
export async function resubmitContextualPlan(
  anchorId: string,
  targetKeys: readonly string[] = [],
  signal?: AbortSignal,
): Promise<ContextualPlanResponse> {
  return post<ContextualPlanResponse>(
    anchorPath(anchorId),
    { resubmit: true, ...extra(targetKeys) },
    signal,
  );
}
