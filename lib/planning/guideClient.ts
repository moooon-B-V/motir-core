import { PlanEditsClientError } from '@/lib/planning/planEditsClient';
import type { GuideTurnRecord } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// The browser's half of the GUIDE door (Story MOTIR-7459 · MOTIR-7466) — the
// three bodies `POST /api/ai/guide` takes (MOTIR-7464) and the settle that lands
// a finished turn (`POST /api/ai/guide/settle`, MOTIR-7470). The job's stream is
// the ask door's shipped relay (`streamAskJob`), which proxies any job of the
// caller's project; nothing about watching a guide job is guide-specific.
//
// Errors arrive as the shipped `PlanEditsClientError`, so the out-of-credits test
// (`isOutOfCredits`) is the one every planning surface already uses.

/** What the door returns for an open, a turn and a re-run. */
export interface GuideTurnResponse {
  outcome: 'guiding';
  /** The job now running for the turn, or null when the door RESUMED. */
  jobId: string | null;
  turnId: string | null;
  started: boolean;
  session: PlanChangeSessionDto;
}

/** What a settle landed. `silent` is a replay, or a job not finished yet. */
export type GuideSettleResponse =
  | { outcome: 'guided'; session: PlanChangeSessionDto; record: GuideTurnRecord }
  | { outcome: 'failed'; session: PlanChangeSessionDto }
  | { outcome: 'silent'; session: PlanChangeSessionDto };

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
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new PlanEditsClientError(res.status, await readErrorCode(res));
  return (await res.json()) as T;
}

/** OPEN the guide on a card: resume the person's conversation, or start one with
 *  the door's opening turn (which runs, so Motir AI speaks first). */
export function openGuideConversation(
  itemKey: string,
  signal?: AbortSignal,
): Promise<GuideTurnResponse> {
  return post('/api/ai/guide', { itemKey }, signal);
}

/** The person's next turn in the conversation. `attachmentIds` are files
 *  already attached to the guided card, in the order the person added them
 *  (Story MOTIR-7471 · MOTIR-7486); a turn with files may carry no words. */
export function sendGuideTurn(
  sessionId: string,
  text: string,
  attachmentIds: readonly string[] = [],
  signal?: AbortSignal,
): Promise<GuideTurnResponse> {
  return post(
    '/api/ai/guide',
    attachmentIds.length > 0 ? { sessionId, text, attachmentIds } : { sessionId, text },
    signal,
  );
}

/** Re-run a turn already on the thread (Try again). Replay-safe server-side. */
export function resubmitGuideTurn(
  sessionId: string,
  turnId: string,
  signal?: AbortSignal,
): Promise<GuideTurnResponse> {
  return post('/api/ai/guide', { sessionId, turnId }, signal);
}

/** Land a finished guide job. Replayable: a second call lands nothing. */
export function settleGuideJob(
  sessionId: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<GuideSettleResponse> {
  return post('/api/ai/guide/settle', { sessionId, jobId }, signal);
}
