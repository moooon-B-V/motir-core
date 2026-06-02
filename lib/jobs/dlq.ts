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
// IDEMPOTENCY CAVEAT (the interaction Subtask 1.6.4 AC calls out): the event is
// re-emitted AS-IS, including its original idempotency key. If the job was
// defined with an `idempotency` expression and Inngest's dedup window has not
// elapsed, Inngest DROPS the replay — same key → no re-execute. To force a
// replay through, either wait the window out, or (when a code change has made
// the original a no-op) re-shape the idempotency key. See docs/jobs.md →
// "Dead-letter queue".
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
  await inngest.send({
    name: row.eventName,
    data: (row.eventData ?? {}) as Record<string, unknown>,
  });
  const replayed = await jobRunDlqRepository.update(dlqId, { replayedAt: new Date() }, tx);
  return toJobRunDlqDTO(replayed);
}
