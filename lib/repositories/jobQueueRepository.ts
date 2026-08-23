import { Prisma, type JobQueueRun, type JobRunState } from '@/generated/prisma/client';

// Data access for `job_queue` — the RUN table the Postgres job engine's worker
// claims from (Story MOTIR-3414 · Subtask MOTIR-3421). Single-op methods only;
// writes require `tx` (the 4-layer contract). `lib/jobs/engine/worker.ts` owns
// the transactions and the loop.
//
// Writes use the UNCHECKED create input (scalar FK) for the reason
// `jobRunRepository.create` records: the runtime writes under the system-admin
// context with no workspace context bound, and a relation `connect` issues a
// SELECT the workspace table's RLS hides.

// ⚠️ EVERY CLOCK EXPRESSION IN THIS FILE IS `(now() AT TIME ZONE 'UTC')`, NEVER
// BARE `now()` — and this is a bug that was CAUGHT rather than avoided.
//
// Prisma maps `DateTime` to `timestamp(3)` WITHOUT time zone and writes it as
// naive UTC. `now()` is a `timestamptz`, so comparing it to such a column casts
// it through the SESSION TimeZone. On this sandbox `SHOW timezone` is
// `America/Los_Angeles`, so the first version of `claimDueRuns` — written with
// bare `now()` — matched NOTHING: a row due one minute ago read as seven hours in
// the future, and every worker test failed with an empty claim.
//
// ⚠️ AND IT WOULD HAVE SHIPPED GREEN. Production Neon runs UTC, where the offset
// is zero and the two forms agree exactly. So does CI. The defect is visible only
// under a non-UTC session, which is precisely why it belongs in code rather than
// in an assumption about the deployment's timezone.
//
// The rule is `(now() AT TIME ZONE 'UTC')` on BOTH SIDES of every read and every
// write, not "bind a JS Date". Binding the writer's clock is right for a
// predicate evaluated inside one process, and WRONG here: `run_at` is written by
// the dispatcher and read by the worker, and `lease_expires_at` is written by the
// worker holding a run and read by a REAPER ON ANOTHER MACHINE. Bind a JS Date
// there and the lease becomes a function of the writer's clock, so machine skew
// surfaces as a live run reaped at random — indistinguishable from a real machine
// death. The database has to be the clock; `AT TIME ZONE 'UTC'` is what makes it
// speak the column's convention.
export const jobQueueRepository = {
  /**
   * ⚠️ THE CLAIM. The single most important query in the engine, and the reason
   * it is raw SQL rather than a Prisma call: `FOR UPDATE SKIP LOCKED` is not
   * expressible through the query builder, and `CLAUDE.md` lists `$queryRaw` as
   * a legal single repository op precisely for this.
   *
   * Claiming is a READ-DERIVED WRITE — read which rows are due, then write a
   * claim based on what was read. Two workers doing that with a plain
   * read-then-write both see the same row and both run the job. Three things
   * make it safe, and all three are load-bearing:
   *
   *   1. **`FOR UPDATE`** takes a row lock, so a second transaction cannot claim
   *      a row this one is claiming.
   *   2. **`SKIP LOCKED`** makes that second worker take the NEXT row instead of
   *      BLOCKING on the first. Without it the claim is correct and serial — N
   *      workers would queue behind one row and the pool would buy nothing.
   *   3. **The state write is in the SAME statement** (`UPDATE … FROM (SELECT …
   *      FOR UPDATE SKIP LOCKED) …`), so there is no window between locking a
   *      row and marking it claimed. A separate UPDATE would still be correct
   *      inside one transaction, but this way the claim cannot be split by an
   *      early return or a thrown error between the two.
   *
   * The `ORDER BY run_at` is what makes the queue fair (oldest due first) and is
   * served by `job_queue_state_run_at_idx` with no sort — asserted by an EXPLAIN
   * in `tests/jobs/engine-schema.test.ts`.
   *
   * ⚠️ A SERIAL TEST CANNOT SEE THE DEFECT THIS PREVENTS. Two sequential claims
   * never collide; the race needs genuine concurrency against a warm pool, which
   * is what `tests/jobs/engine-worker.test.ts` drives.
   */
  async claimDueRuns(
    workerId: string,
    limit: number,
    leaseMs: number,
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun[]> {
    return tx.$queryRaw<JobQueueRun[]>`
      UPDATE "job_queue" AS q
         SET "state"            = 'running',
             "claimed_by"       = ${workerId},
             "lease_expires_at" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}::double precision),
             "attempts"         = q."attempts" + 1,
             "updated_at"       = (now() AT TIME ZONE 'UTC')
        FROM (
              SELECT "id"
                FROM "job_queue"
               WHERE "state" = 'pending'
                 AND "run_at" <= (now() AT TIME ZONE 'UTC')
               ORDER BY "run_at"
                 FOR UPDATE SKIP LOCKED
               LIMIT ${limit}
             ) AS due
       WHERE q."id" = due."id"
      RETURNING q."id",
                q."job_id"           AS "jobId",
                q."event_id"         AS "eventId",
                q."event_name"       AS "eventName",
                q."workspace_id"     AS "workspaceId",
                q."run_at"           AS "runAt",
                q."attempts",
                q."max_attempts"     AS "maxAttempts",
                q."state",
                q."claimed_by"       AS "claimedBy",
                q."lease_expires_at" AS "leaseExpiresAt",
                q."last_error"       AS "lastError",
                q."created_at"       AS "createdAt",
                q."updated_at"       AS "updatedAt"
    `;
  },

  /**
   * RECLAIM abandoned runs: `running` rows whose lease has expired, back to
   * `pending` so a live worker can take them.
   *
   * ⚠️ THE ATTEMPT IS GIVEN BACK. `claimDueRuns` increments `attempts` at the
   * claim, so a worker that DIED mid-run has already spent one. Not refunding it
   * would let a crash-loop (an OOM, a rolling deploy catching the same long run
   * twice) exhaust a job's whole retry budget without the handler ever having
   * failed — the run would dead-letter with no error to show an operator. A
   * genuine handler failure is counted on the failure path instead, where there
   * is something to record.
   */
  async reclaimExpiredLeases(tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.$executeRaw`
      UPDATE "job_queue"
         SET "state"            = 'pending',
             "claimed_by"       = NULL,
             "lease_expires_at" = NULL,
             "attempts"         = GREATEST("attempts" - 1, 0),
             "updated_at"       = (now() AT TIME ZONE 'UTC')
       WHERE "state" = 'running'
         AND "lease_expires_at" IS NOT NULL
         AND "lease_expires_at" < (now() AT TIME ZONE 'UTC')
    `;
    return r;
  },

  /**
   * Extend the lease on runs this worker still holds — the RENEWAL half of the
   * lease. A run legitimately longer than one lease period (a supervisor, a big
   * index) must not be reclaimed out from under a worker that is alive and
   * working, and a heartbeat is the only way to tell that apart from a worker
   * that died.
   *
   * Scoped to `claimed_by = workerId` so a worker can only ever renew its own.
   */
  async renewLeases(
    workerId: string,
    leaseMs: number,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "job_queue"
         SET "lease_expires_at" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}::double precision),
             "updated_at"       = (now() AT TIME ZONE 'UTC')
       WHERE "state" = 'running'
         AND "claimed_by" = ${workerId}
    `;
  },

  /**
   * RELEASE the runs this worker holds, back to `pending` — the graceful-shutdown
   * path. Same attempt refund as the reclaim above, for the same reason: a
   * deploy is a routine event and must not cost a job an attempt.
   *
   * `runAt` is left where it is, so a released run is immediately claimable by
   * whichever machine is still up. That is the difference between draining and
   * dropping.
   */
  async releaseClaims(workerId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      UPDATE "job_queue"
         SET "state"            = 'pending',
             "claimed_by"       = NULL,
             "lease_expires_at" = NULL,
             "attempts"         = GREATEST("attempts" - 1, 0),
             "updated_at"       = (now() AT TIME ZONE 'UTC')
       WHERE "state" = 'running'
         AND "claimed_by" = ${workerId}
    `;
  },

  /** Terminal success. */
  async markSucceeded(id: string, tx: Prisma.TransactionClient): Promise<JobQueueRun> {
    return tx.jobQueueRun.update({
      where: { id },
      data: { state: 'succeeded', claimedBy: null, leaseExpiresAt: null },
    });
  },

  /**
   * Terminal failure — the retry budget is spent. `lastError` carries the final
   * failure so an operator sees WHY without reading a log, mirroring
   * `job_run.failure`.
   */
  async markFailed(
    id: string,
    lastError: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun> {
    return tx.jobQueueRun.update({
      where: { id },
      data: { state: 'failed', claimedBy: null, leaseExpiresAt: null, lastError },
    });
  },

  /**
   * Re-enqueue for another attempt (a retry's backoff) or for a resume (a
   * `step.sleep` yield). One method for both because the row change is
   * identical — back to `pending` at a future `run_at` — and the DIFFERENCE is
   * whether `attempts` was spent, which the caller has already decided.
   */
  async rescheduleAt(
    id: string,
    runAt: Date,
    tx: Prisma.TransactionClient,
    opts?: { refundAttempt?: boolean; lastError?: Prisma.InputJsonValue },
  ): Promise<JobQueueRun> {
    return tx.jobQueueRun.update({
      where: { id },
      data: {
        state: 'pending',
        runAt,
        claimedBy: null,
        leaseExpiresAt: null,
        ...(opts?.refundAttempt ? { attempts: { decrement: 1 } } : {}),
        ...(opts?.lastError !== undefined ? { lastError: opts.lastError } : {}),
      },
    });
  },

  /** Insert one run. The dispatcher's write (MOTIR-3423) and the tests' seed. */
  async create(
    data: Prisma.JobQueueRunUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobQueueRun> {
    return tx.jobQueueRun.create({ data });
  },

  /** Read one run by id. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobQueueRun | null> {
    return tx.jobQueueRun.findUnique({ where: { id } });
  },

  /** Count runs in a state — an operator/read surface and the tests' assertion handle. */
  async countByState(state: JobRunState, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobQueueRun.count({ where: { state } });
  },
};
