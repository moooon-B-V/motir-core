import type { PlanDelta } from '@/lib/ai/planDelta';

export const OUT_OF_CREDITS_CODE = 'MOTIR_AI_OUT_OF_CREDITS';

export class PlanEditsClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Plan edits request failed (${status})`);
    this.name = 'PlanEditsClientError';
  }

  get isOutOfCredits(): boolean {
    return this.status === 402 || this.code === OUT_OF_CREDITS_CODE;
  }
}

export interface PlanEditJobResult {
  jobId: string;
  delta: PlanDelta;
  locked: PlanDeltaLockedItem[];
  provenance: PlanDeltaRelatedItem[];
}

export interface PlanDeltaLockedItem {
  key: string;
  kind: string;
  title: string;
}

export interface PlanDeltaRelatedItem {
  key: string;
  kind: string;
  title: string;
  relevance: string;
}

/**
 * What the three plan-edit submit routes return. `planId` — the `generating`
 * Plan the job's proposals append into (MOTIR-1743) — is OPTIONAL on purpose:
 * it is an additive echo, and a caller must not depend on it (an E2E stub or a
 * pre-1743 response carries only `jobId`). Read it defensively.
 */
export interface PlanEditSubmitResponse {
  jobId: string;
  planId?: string;
}

export interface ApproveDeltaResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: string };
    return body.code ?? null;
  } catch {
    return null;
  }
}

export async function submitAugmentJob(
  prompt: string,
  signal?: AbortSignal,
): Promise<PlanEditSubmitResponse> {
  const res = await fetch('/api/ai/augment', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as PlanEditSubmitResponse;
}

export async function submitExpandJob(
  itemKey: string,
  signal?: AbortSignal,
): Promise<PlanEditSubmitResponse> {
  const res = await fetch('/api/ai/expand', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as PlanEditSubmitResponse;
}

export async function submitReplanJob(
  itemKey: string,
  signal?: AbortSignal,
): Promise<PlanEditSubmitResponse> {
  const res = await fetch('/api/ai/replan', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as PlanEditSubmitResponse;
}

export async function approvePlanDelta(
  jobId: string,
  editedDelta: unknown,
  signal?: AbortSignal,
): Promise<ApproveDeltaResult> {
  const res = await fetch('/api/ai/plan-delta/approve', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, editedDelta }),
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as ApproveDeltaResult;
}

export async function streamAugmentJob(
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  /** Every non-terminal frame, in arrival order (MOTIR-1730). The `augment` job's
   *  SSE carries structured PROGRESS frames (`search` / `drill` / `level_complete`
   *  / `pass` / `planned` / `validated`), which the conversational rail narrates
   *  live while the delta is computed. Optional — the dock consumers ignore them. */
  onFrame?: (event: string, data: unknown) => void,
): Promise<void> {
  return consumeStream(
    `/api/ai/augment/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
    onFrame,
  );
}

/** The ITEM-ANCHORED stream (7.12.3 · MOTIR-909's relay, consumed by the
 *  MOTIR-910 entrance). Same SSE shape as `streamAugmentJob` — the job IS an
 *  ordinary `augment` — but subscribed through the anchored route, which re-gates
 *  the anchor on every subscribe. */
export async function streamContextualPlanJob(
  anchorId: string,
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  onFrame?: (event: string, data: unknown) => void,
): Promise<void> {
  return consumeStream(
    `/api/work-items/${encodeURIComponent(anchorId)}/ai/plan/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
    onFrame,
  );
}

export async function streamExpandJob(
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
): Promise<void> {
  return consumeStream(
    `/api/ai/expand/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
  );
}

export async function streamReplanJob(
  jobId: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
): Promise<void> {
  return consumeStream(
    `/api/ai/replan/${encodeURIComponent(jobId)}/stream`,
    signal,
    onError,
    onDone,
  );
}

/**
 * The ONE SSE consumer every job stream in the app goes through. Exported
 * (MOTIR-1750) so the sprint-planning client subscribes through it instead of
 * introducing a second streaming implementation — same frame parsing, same
 * `error` / `done` terminal contract, same abort semantics.
 */
export async function consumeStream(
  url: string,
  signal: AbortSignal,
  onError: (code: string | null) => void,
  onDone: () => void,
  onFrame?: (event: string, data: unknown) => void,
): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      const code = await readErrorCode(res);
      onError(code);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = drainLocal(buffer);
      buffer = rest;
      for (const { event, data } of frames) {
        if (event === 'error') {
          onError((data as { code?: string } | null)?.code ?? null);
          return;
        }
        if (event === 'done') {
          onDone();
          return;
        }
        onFrame?.(event, data);
      }
    }
    onDone();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    onError(null);
  }
}

interface SseFrame {
  event: string;
  data: unknown;
}

export async function fetchJobResult(
  jobId: string,
  signal?: AbortSignal,
): Promise<{ status: string; result: { planDelta: PlanDelta } | null }> {
  const res = await fetch(`/api/ai/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as { status: string; result: { planDelta: PlanDelta } | null };
}

function drainLocal(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let sep = rest.indexOf('\n\n');
  while (sep !== -1) {
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const parsed = parseLocal(raw);
    if (parsed) frames.push(parsed);
    sep = rest.indexOf('\n\n');
  }
  return { frames, rest };
}

function parseLocal(frame: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    // leave as raw string
  }
  return { event, data };
}
