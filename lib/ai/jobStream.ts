import 'server-only';
import { getJob } from '@/lib/ai/motirAiClient';
import type { JobStreamEvent } from '@/lib/ai/types';

// Enrich a relayed job-stream frame with its terminal-failure REASON (Subtask
// 8.1.8). The raw `/v1/jobs/:id/stream` SSE protocol emits a `status` frame
// (`{ status: 'failed' }`) and a `done` frame when a job ends badly, but NOT the
// failure's problem+json — that lives only on `GET /v1/jobs/:id` (JobView.error).
// So a client watching the stream alone learns THAT a job failed, never WHY (e.g.
// out-of-credits vs a transient outage).
//
// This closes that gap inside motir-core (no motir-ai change): the stream ROUTE
// calls this for each frame it relays. On the terminal `failed` status it fetches
// the job's mapped error once and returns a synthesised `error` frame carrying
// the typed `code` — the SAME shape the routes already emit for a transport
// failure. Both SSE consumers (`useDiscoveryChat`, `useExplanationDraft`) already
// route an `error` frame's `code` into their error state, so a
// `MOTIR_AI_OUT_OF_CREDITS` refusal reaches the 8.1.8 paywall.
//
// It lives in the ROUTE relay loop (not a stream wrapper) deliberately: the route
// owns the upstream iterator, so a client disconnect still cancels it promptly —
// a wrapper generator parked on a hung upstream pull could not be returned in
// time. `readJobError` is injected so it is unit-testable without a live boundary.
export async function failureReasonFrame(
  jobId: string,
  frame: JobStreamEvent,
  readJobError: (jobId: string) => Promise<{ code: string; message: string } | null> = async (
    id,
  ) => {
    const view = await getJob(id);
    return view.error ? { code: view.error.code, message: view.error.message } : null;
  },
): Promise<JobStreamEvent | null> {
  if (frame.event !== 'status' || !isFailedStatus(frame.data)) return null;
  const reason = await readJobError(jobId).catch(() => null);
  if (!reason) return null;
  return { event: 'error', data: { code: reason.code, message: reason.message } };
}

function isFailedStatus(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null && (data as { status?: unknown }).status === 'failed'
  );
}
