import type { Prisma } from '@prisma/client';
import { inngest } from './client';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { toJobRunDlqDTO } from '@/lib/mappers/jobMappers';
import type { JobRunDlqDTO } from '@/lib/dto/jobs';

// Dead-letter replay (Story 1.6 · Subtask 1.6.4). The service-layer function the
// 1.6.5 dashboard's "Replay" button calls: it re-emits a dead-lettered job's
// ORIGINAL event, then stamps the DLQ row's `replayedAt` so the action is
// auditable (an operator can see when an entry was retried).
//
// Operates on the caller's transaction — the dashboard Server Action opens the
// tx and binds the operator's RLS context (Story 1.5 identity propagation), so
// `replayDLQ` owns neither the transaction nor the context, only the two steps
// inside it. That keeps it composable with whatever surface invokes it.
//
// ORDERING: re-emit first, THEN stamp. So a row with `replayedAt` set always
// means the event was actually published — a stamp is never written for a send
// that didn't happen. (The reverse — stamp then send — could record a replay
// that never went out if the publish threw.)
//
// IDEMPOTENCY ON REPLAY (reworked in 1.6.6 — PRODECT_FINDINGS #40). 1.6.4
// re-emitted the event AS-IS, including its original idempotency key. But an
// operator replays a dead-lettered job precisely when they've fixed a transient
// failure and want it to run NOW — and the original key is, by definition, still
// inside Inngest's dedup window, so the runtime DROPPED the re-emit and nothing
// re-ran. Worse, the dashboard's Replay button still stamped `replayedAt` and
// toasted success, so the no-op was invisible. So replay now RE-SHAPES the key:
// the re-emitted event carries `{original}:replay:{dlqId}`, distinct from the
// original, so Inngest treats it as a new run and actually executes it. The new
// key is derived from the DLQ row id (not a timestamp), so a double-click of
// Replay on the SAME row still dedups to one re-run (no double-delivery), while
// a genuinely new failure — a new dlq row — replays independently. A job with no
// idempotency key is unaffected (it already replayed unconditionally).
//
// Why the raw client and not `sendEvent`: dlq.ts lives in lib/jobs/** so it may
// import the Inngest SDK. The stored `eventData` is dynamic jsonb (it can be ANY
// job's payload, including system/cron jobs that never go through `sendEvent`),
// so it bypasses `sendEvent`'s compile-time event typing. Re-validating an
// untyped payload against the runtime workspace guard adds no safety — the
// original send already satisfied the workspace-scoping invariant.

/**
 * Replay a dead-lettered job by re-emitting its original event, then stamping
 * `replayedAt`. Returns the updated DLQ DTO. Throws if the id is unknown.
 */
export async function replayDLQ(
  dlqId: string,
  tx: Prisma.TransactionClient,
): Promise<JobRunDlqDTO> {
  const row = await jobRunDlqRepository.findById(dlqId, tx);
  if (!row) {
    throw new Error(`job_run_dlq ${dlqId} not found`);
  }
  const originalData = (row.eventData ?? {}) as Record<string, unknown>;
  // Re-shape the idempotency key (see header comment) so the replay isn't
  // dedup-dropped. Only when the stored payload actually carries a string key;
  // otherwise re-emit untouched.
  const replayData =
    typeof originalData['idempotencyKey'] === 'string'
      ? { ...originalData, idempotencyKey: `${originalData['idempotencyKey']}:replay:${dlqId}` }
      : originalData;
  await inngest.send({ name: row.eventName, data: replayData });
  const replayed = await jobRunDlqRepository.update(dlqId, { replayedAt: new Date() }, tx);
  return toJobRunDlqDTO(replayed);
}
