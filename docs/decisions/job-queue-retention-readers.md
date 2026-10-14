# `job_queue` retention — who reads a terminal row

Audit for [MOTIR-8582], consumed by [MOTIR-8540] (the `job_queue` retention pass).
Taken at `main` `9b538d7d56a7e63c5dd6d53222e00526aad9329f` on 2026-10-14.

The question: once the pass deletes a `succeeded` `job_queue` row older than the
window, does anything still read it? Every hit of the three commands below is a
row in the table or a comment.

| Command                                                 | Hits                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `git grep -n 'jobQueueRun\.\|"job_queue"' -- lib app`   | 20 (19 in `jobQueueRepository.ts`, 1 at `jobRunRepository.ts:177`)                                         |
| `git grep -n 'jobQueueRepository\.' -- lib app scripts` | 25 (22 calls, 3 comments: `ciRunnerFleet.ts:164`, `dlq.ts:148`, `githubPullRequestReviewRepository.ts:87`) |
| `git grep -n 'job_queue' -- prisma lib app scripts`     | 113 (76 outside `prisma/migrations`; the non-repository ones are doc comments and type comments)           |

## Readers

| Reader (file:symbol)                                                                                                                                                                              | What it reads                                                                                                           | Keep-rule                                                                                                                                                                         | Evidence                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `lib/jobs/engine/worker.ts` (`claimDueRuns`, `reclaimExpiredLeases`, `renewLeases`, `releaseClaims`, `markSucceeded`, `markFailed`, `rescheduleAt`) and `scripts/worker.ts:236` (`releaseClaims`) | `pending` / `running` rows, or one row by id while its run is live                                                      | none: never reads a terminal row                                                                                                                                                  | `worker.ts:423,430,512,519,538,563,574,672,728`                     |
| `lib/services/platformHealthService.ts:239` `readQueueHealth` → `readDueBacklog`                                                                                                                  | due `pending` rows                                                                                                      | none                                                                                                                                                                              | `jobQueueRepository.readDueBacklog` filters `state = 'pending'`     |
| `lib/services/jobRunsService.ts:345` → `countLiveForEventRef`                                                                                                                                     | `pending` / `running` rows for one event ref                                                                            | none                                                                                                                                                                              | filters `state IN ('pending','running')`                            |
| `lib/repositories/jobRunRepository.ts:177` `findExpiredTerminalIds`                                                                                                                               | `pending` / `running` rows (NOT EXISTS guard)                                                                           | none                                                                                                                                                                              | raw SQL filters `q."state" IN ('pending','running')`                |
| `lib/jobs/engine/dispatcher.ts:296,303` `findPendingDebouncedForUpdate` / `coalesceDebounced`                                                                                                     | the `pending` row holding a debounce key                                                                                | none: the debounce partial unique is `pending`-only                                                                                                                               | dispatcher `enqueueDebounced`                                       |
| `lib/jobs/engine/dispatcher.ts:223,318` `create` (catches P2002 as "already enqueued")                                                                                                            | the three uniques: `(event_id, job_id)`, `(job_id, scheduled_for)`, partial `(job_id, idempotency_key)`, over ANY state | **dedup horizon**: a key is deduplicated only while a row carrying it exists                                                                                                      | dispatcher.ts:241 `isUniqueViolation` → `alreadyEnqueued`           |
| `lib/jobs/dlq.ts:127` `replayDeadLetter` → `createIfAbsent`                                                                                                                                       | the partial `(job_id, idempotency_key)` unique, any state                                                               | dedup horizon, as above; replay keys are `{original}:replay:{dlqId}`                                                                                                              | dlq.ts:106 `reshapeReplayKey`, :146 `already-replayed`              |
| `lib/jobs/engine/scheduler.ts:219` `enqueueScheduled`                                                                                                                                             | `(job_id, scheduled_for)` unique, any state                                                                             | dedup horizon                                                                                                                                                                     | catches P2002 → `already-queued`                                    |
| `lib/jobs/engine/scheduler.ts:274` `latestScheduledFor`                                                                                                                                           | newest `scheduled_for` row per job, **any state**                                                                       | **the newest `scheduled_for` row per job must survive** (it is the catch-up watermark)                                                                                            | repository `findFirst … orderBy scheduledFor desc`, no state filter |
| `lib/services/supervisionSweepService.ts:320` `runIsStillLive` → `findById`                                                                                                                       | the run a `job_supervision` row hangs off                                                                               | none: absent reads as "not live", the same verdict as `succeeded`                                                                                                                 | `if (!run) return false`                                            |
| `lib/services/monitorSyncProbeService.ts:63` `resolveRunFor` → `findForEventAndJob`                                                                                                               | the newest run for one event, any state                                                                                 | none in practice: an acceptance-walk `_test` door asking about the NEWEST transition; a purged run reads `none` instead of `terminal` only for a transition older than the window | `if (!run) return 'none'`                                           |
| `jobQueueRepository.countByState`                                                                                                                                                                 | counts by state                                                                                                         | none: an operator count, shrinks as intended                                                                                                                                      | repository                                                          |

## Schema

- `job_step.run_id → job_queue.id`, `ON DELETE CASCADE` — `prisma/schema.prisma:4615`
  (migration `20260823230609_add_postgres_job_engine_tables`).
- `job_supervision.run_id → job_queue.id`, `ON DELETE CASCADE` — `prisma/schema.prisma:4743`
  (migration `20260828213000_add_job_supervision`).
- `job_queue.event_id → job_event.id`, `ON DELETE CASCADE` — `prisma/schema.prisma:4512`.
  Nothing else references `job_event`, and nothing else references `job_queue`.
  Deleting an event would cascade to its queue rows, so events are only deleted
  once orphaned (no queue row of any state).
- `job_run` and `job_run_dlq` carry no FK to `job_queue`; `job_run.event_id` may hold a
  `job_queue.id` by value (`jobRunRepository.ts:181`), read only for live rows.

## DLQ

`dlq.ts` reads the `job_run_dlq` row and writes a fresh `job_event` + `job_queue`
pair; it never reads an old `succeeded` queue row. Replay needs none. A second
replay of the same DLQ row is refused by the idempotency unique only while the
first replay's queue row exists, so past the window a second press enqueues again
(the `replayedAt` stamp still records the first).

## Findings that change the pass design

1. **`job_event` has no `created_at`; its timestamp is `received_at`**
   (`schema.prisma:4403`, `receivedAt @map("received_at")`). The orphaned-event
   delete uses `received_at`.
2. **Keep the newest `scheduled_for` row per job**, in any state, or the scheduler's
   catch-up watermark moves backwards and a `catchUp` job re-fires.
3. Deleting a run deletes its `job_step` memo and any `job_supervision` row by
   cascade. Steps of a succeeded run are dead weight; a supervision still hanging
   off a succeeded run is the bug state `runIsStillLive` already treats as dead,
   so the cascade removes it rather than the sweep reporting it.

[MOTIR-8540]: https://motir.co/items/MOTIR-8540
[MOTIR-8582]: https://motir.co/items/MOTIR-8582
