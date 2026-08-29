import { Prisma, type JobSupervision, type JobSupervisionState } from '@/generated/prisma/client';

// Data access for `job_supervision` — the per-poll state one supervision carries
// BETWEEN passes (Story MOTIR-3778 · Subtask MOTIR-3826). Single-op methods
// only; writes require `tx` (the 4-layer contract). The supervision driver
// (MOTIR-3827) owns the transactions, and the abandoned-supervision sweep
// (MOTIR-3830) is the only other reader.
//
// `docs/decisions/job-queue-foundation.md` §16.2 is why this is a table rather
// than the queue row's payload or an existing fleet row, and §16.3 is why it
// cannot be the step ledger: a `step.run` under a fixed id freezes its FIRST
// answer for the life of the run, and this is the state that must change.
//
// Every write uses the UNCHECKED create/update input (a scalar `workspaceId` FK)
// rather than `workspace: { connect }`, for the reason `jobStepRepository` and
// `jobRunRepository.create` both record: the job runtime writes under the
// system-admin context with no workspace context bound, and a `connect` issues a
// SELECT on `workspace` that the workspace table's RLS hides. The scalar sets
// the column directly, and the Postgres FK constraint still enforces referential
// integrity — FK checks are not subject to RLS.
//
// ⚠️ EVERY READ TAKES `tx`, INCLUDING THE ONES THAT GUARD NOTHING. `CLAUDE.md`
// permits a pure read on the `db` singleton, and it would be wrong here: these
// rows are read on the engine's own path, inside the system-context transaction
// that binds `app.system_admin`, and without that GUC the policy hides every
// untenanted (system-job) row — which is every row a supervisor writes. Same
// call `jobStepRepository.findByRunAndStep` makes, for the same reason.

/** What one advanced poll observed. Exactly the fields that change between passes. */
export interface JobSupervisionAdvance {
  /** The observed container start, once a SUCCESSFUL provider read has produced one. */
  startedAt: Date | null;
  consecutiveReadFailures: number;
  /** When the next poll is due — the instant the run is being deferred to. */
  nextPollAt: Date;
}

export const jobSupervisionRepository = {
  /**
   * The state lookup: `(run_id, subject)`, the unique key the whole machine
   * turns on. A read, on the engine's path — see the header for why it takes
   * `tx` rather than the singleton.
   */
  async findByRunAndSubject(
    runId: string,
    subject: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobSupervision | null> {
    return tx.jobSupervision.findUnique({ where: { runId_subject: { runId, subject } } });
  },

  /**
   * The same read, LOCKED — `SELECT … FOR UPDATE` — for the path that then
   * writes a value derived from it.
   *
   * ⚠️ IT IS NOT BELT-AND-BRACES. Advancing a poll number, or moving `watching`
   * to `settling`, is a READ-DERIVED WRITE, and two workers can legitimately
   * hold one run at once: `reclaimExpiredLeases` hands a run to a second worker
   * while the first is still inside a provider call it has not returned from
   * (the lease is 60 s and a `describe` has a 30 s deadline). Without the lock
   * the two read the same `poll_number` and both write the same successor, so
   * the count silently stops bounding anything — and on the settle path both
   * would enter the terminal transition and tear the container down twice.
   *
   * Raw SQL because `FOR UPDATE` is not expressible through the query builder,
   * which is the one case `CLAUDE.md` names `$queryRaw` as a legal single
   * repository op for. Returns at most one row.
   */
  async findByRunAndSubjectForUpdate(
    runId: string,
    subject: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobSupervision | null> {
    const rows = await tx.$queryRaw<JobSupervision[]>`
      SELECT "id",
             "run_id"                    AS "runId",
             "subject",
             "kind",
             "poll_number"               AS "pollNumber",
             "started_at"                AS "startedAt",
             "consecutive_read_failures" AS "consecutiveReadFailures",
             "next_poll_at"              AS "nextPollAt",
             "state",
             "workspace_id"              AS "workspaceId",
             "created_at"                AS "createdAt",
             "updated_at"                AS "updatedAt"
        FROM "job_supervision"
       WHERE "run_id" = ${runId}
         AND "subject" = ${subject}
         FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Open a supervision, or return the one already open.
   *
   * An UPSERT rather than a `create`, because the pass that opens it is the same
   * pass that opens it again after a lease reclaim replayed the boot from its
   * memo — and re-entering a live supervision must not be a constraint
   * violation. The update arm is deliberately EMPTY of observation fields: an
   * open row's `poll_number`, `started_at` and `consecutive_read_failures` are
   * what this call must not clobber, and `advance` is the only door onto them.
   */
  async open(
    data: {
      runId: string;
      subject: string;
      kind: string;
      nextPollAt: Date;
      workspaceId: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<JobSupervision> {
    return tx.jobSupervision.upsert({
      where: { runId_subject: { runId: data.runId, subject: data.subject } },
      create: data,
      update: {},
    });
  },

  /**
   * Record ONE advanced poll: the poll number goes up by one and the
   * observations are replaced by what the pass just read.
   *
   * `poll_number` is incremented in the DATABASE (`{ increment: 1 }`) rather
   * than written from a value the caller read, so the statement is correct even
   * where the caller did not take the lock above — the lock is what makes the
   * whole read-decide-write sequence atomic, and this is what keeps the counter
   * itself monotonic regardless.
   */
  async advance(
    runId: string,
    subject: string,
    observation: JobSupervisionAdvance,
    tx: Prisma.TransactionClient,
  ): Promise<JobSupervision> {
    return tx.jobSupervision.update({
      where: { runId_subject: { runId, subject } },
      data: {
        pollNumber: { increment: 1 },
        startedAt: observation.startedAt,
        consecutiveReadFailures: observation.consecutiveReadFailures,
        nextPollAt: observation.nextPollAt,
      },
    });
  },

  /**
   * Move the row's lifecycle state — `watching` → `settling` when a terminal
   * transition is entered, `settling` → `settled` when teardown returned.
   *
   * The two are separate writes on purpose (§16.4): `settling` is what stops a
   * concurrent pass entering a second teardown, and it has to be visible while
   * the teardown is still in flight, which a single write at the end could not
   * be.
   */
  async markState(
    runId: string,
    subject: string,
    state: JobSupervisionState,
    tx: Prisma.TransactionClient,
  ): Promise<JobSupervision> {
    return tx.jobSupervision.update({
      where: { runId_subject: { runId, subject } },
      data: { state },
    });
  },

  /**
   * THE SWEEP'S READ (MOTIR-3830): supervisions still `watching` whose next poll
   * was due before `olderThan`.
   *
   * A chain that has stopped advancing is exactly this — the run that owed the
   * next poll never came back. It is keyed on `next_poll_at` rather than on the
   * container's age deliberately: a healthy thirty-minute index IS old, so the
   * container's age answers a different question with a "yes" for every one of
   * them. Served by `job_supervision_state_next_poll_at_idx`.
   */
  async listStalled(
    olderThan: Date,
    tx: Prisma.TransactionClient,
    limit = 50,
  ): Promise<JobSupervision[]> {
    return tx.jobSupervision.findMany({
      where: { state: 'watching', nextPollAt: { lt: olderThan } },
      orderBy: { nextPollAt: 'asc' },
      take: limit,
    });
  },

  /** Every supervision of one run — the driver's fan-out view, and the sweep's attribution read. */
  async listByRun(runId: string, tx: Prisma.TransactionClient): Promise<JobSupervision[]> {
    return tx.jobSupervision.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  },

  /**
   * Delete every supervision row of one run.
   *
   * The table's size tracks LIVE supervisions rather than history: the outcome a
   * settled supervision reached is already in `index-settle:<subject>`'s memo
   * and in the run's `job_run` row, so keeping a second copy here would be a
   * second source of truth that ages instead of a record anyone reads.
   * (`ON DELETE CASCADE` from `job_queue` covers the run being deleted; this is
   * for the run that SUCCEEDS and stays.)
   */
  async deleteByRun(runId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.jobSupervision.deleteMany({ where: { runId } });
    return r.count;
  },
};
