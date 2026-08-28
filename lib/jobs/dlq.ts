import type { Prisma } from '@/generated/prisma/client';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { toJobRunDlqDTO } from '@/lib/mappers/jobMappers';
import type { JobRunDlqDTO } from '@/lib/dto/jobs';
import { engineJob } from './engine/registry';
import { resolveIdempotencyKey } from './engine/idempotency';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { jobEventRepository } from '@/lib/repositories/jobEventRepository';

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
// inside the dedup window, so the runtime DROPPED the re-emit and nothing
// re-ran. Worse, the dashboard's Replay button still stamped `replayedAt` and
// toasted success, so the no-op was invisible. So replay RE-SHAPES the key: the
// re-emitted event carries `{original}:replay:{dlqId}`, distinct from the
// original, so it is treated as a new run and actually executes. The new key is
// derived from the DLQ row id (not a timestamp), so a double-click of Replay on
// the SAME row still dedups to one re-run (no double-delivery), while a genuinely
// new failure — a new dlq row — replays independently. A job with no idempotency
// key is unaffected (it already replayed unconditionally).
//
// Why it enqueues directly and not through `sendEvent`: the stored `eventData` is
// dynamic jsonb (it can be ANY job's payload, including system/cron jobs that
// never go through `sendEvent`), so it bypasses `sendEvent`'s compile-time event
// typing. Re-validating an untyped payload against the runtime workspace guard
// adds no safety — the original send already satisfied the workspace-scoping
// invariant.

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

  // ⚠️ A REPLAY IS A FRESH `job_event` + `job_queue` PAIR, never a reset of the
  // dead run (MOTIR-3424). The original run's step ledger records work that DID
  // complete, and re-running the same row would skip precisely the steps an
  // operator is replaying in order to re-do. A new run starts clean.
  //
  // It runs in the CALLER's transaction, exactly as the stamp below does — this
  // function owns neither the transaction nor the RLS context.
  //
  // ⚠️ THE REPLAY KEY IS RE-SHAPED (MOTIR-3459): replaying with the ORIGINAL key
  // would hit the `(job_id, idempotency_key)` partial unique index, be swallowed
  // as "already enqueued", and hand the operator a success toast and a
  // `replayedAt` stamp for a run that never happened — the same silent no-op this
  // function's own header says it exists to prevent, wearing different clothes.
  //
  // (This used to be one of TWO arms, chosen by the per-job cutover switch. The
  // switch and its other arm went with MOTIR-3418; the reshape did not, because
  // it was never the vendor's dedup window it was protecting against here.)
  const replayData = reshapeReplayKey(originalData, dlqId);

  const def = engineJob(row.functionId);
  const event = await jobEventRepository.create(
    {
      name: row.eventName,
      data: (replayData ?? {}) as Prisma.InputJsonValue,
      workspaceId: row.workspaceId,
      idempotencyKey:
        typeof replayData['idempotencyKey'] === 'string' ? replayData['idempotencyKey'] : null,
    },
    tx,
  );
  await jobQueueRepository.create(
    {
      jobId: row.functionId,
      eventId: event.id,
      eventName: row.eventName,
      workspaceId: row.workspaceId,
      runAt: new Date(),
      // A job whose definition module has not been evaluated in THIS process
      // still has to be replayable, so fall back to the default policy's budget
      // rather than refusing. `transient`'s 3 is what `defineJob` would have
      // resolved for a job that declared nothing.
      maxAttempts: def?.maxAttempts ?? 3,
      idempotencyKey: resolveIdempotencyKey(def?.idempotency, replayData, row.functionId),
    },
    tx,
  );
  const replayed = await jobRunDlqRepository.update(dlqId, { replayedAt: new Date() }, tx);
  return toJobRunDlqDTO(replayed);
}

/**
 * Re-shape a replayed event's idempotency key so the replay is not dedup-dropped.
 *
 * Suffixing with the DLQ row id makes each replay of the same dead run its own
 * key while keeping the original readable in it. Only when the stored payload
 * actually carries a string key; otherwise the payload is returned untouched.
 */
function reshapeReplayKey(data: Record<string, unknown>, dlqId: string): Record<string, unknown> {
  return typeof data['idempotencyKey'] === 'string'
    ? { ...data, idempotencyKey: `${data['idempotencyKey']}:replay:${dlqId}` }
    : data;
}
