import { Prisma, type JobStep, type JobStepKind } from '@/generated/prisma/client';

// Data access for `job_step` — the memoized step ledger of the Postgres job
// engine (Story MOTIR-3414 · Subtask MOTIR-3422). Single-op methods only; writes
// require `tx` (the 4-layer contract). The step shim in `lib/jobs/engine/step.ts`
// owns the transactions.
//
// Every write uses the UNCHECKED create input (a scalar `workspaceId` FK) rather
// than `workspace: { connect }`, for the reason `jobRunRepository.create`
// records: the job runtime writes under the system-admin context with no
// workspace context bound, and a `connect` issues a SELECT on `workspace` that
// the workspace table's RLS hides. The scalar FK sets the column directly and
// the Postgres FK constraint still enforces referential integrity — FK checks
// are not subject to RLS.
export const jobStepRepository = {
  /**
   * The MEMO LOOKUP: `(run_id, step_id)`, the unique key the whole shim turns
   * on. A pure read on the engine's own path, so it takes `tx` — it is read
   * inside the system-context transaction that binds `app.system_admin`, without
   * which the policy hides every untenanted (system-job) row.
   */
  async findByRunAndStep(
    runId: string,
    stepId: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobStep | null> {
    return tx.jobStep.findUnique({ where: { runId_stepId: { runId, stepId } } });
  },

  /** Every step recorded for one run, oldest first. Used by the crash-resume tests and the operator surface. */
  async listByRun(runId: string, tx: Prisma.TransactionClient): Promise<JobStep[]> {
    return tx.jobStep.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  },

  /**
   * Persist one memoized step. Throws Prisma's `P2002` when `(run_id, step_id)`
   * already exists — which the shim CATCHES rather than prevents: a lost race is
   * a legitimate outcome there, and the winner's stored result is the one both
   * callers must go on to see.
   */
  async create(
    data: Prisma.JobStepUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobStep> {
    return tx.jobStep.create({ data });
  },

  /**
   * Move a `sleep` checkpoint's deadline. Used only by the resume path when a
   * sleep is re-entered — never to re-time a completed step.
   */
  async updateSleepUntil(
    id: string,
    sleepUntil: Date,
    tx: Prisma.TransactionClient,
  ): Promise<JobStep> {
    return tx.jobStep.update({ where: { id }, data: { sleepUntil } });
  },

  /** Delete every step of a run. The retry path does NOT use this — see the shim's header. */
  async deleteByRun(runId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.jobStep.deleteMany({ where: { runId } });
    return r.count;
  },

  /** Count a run's steps of one kind. A cheap assertion surface for the tests and the dashboard. */
  async countByRunAndKind(
    runId: string,
    kind: JobStepKind,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.jobStep.count({ where: { runId, kind } });
  },
};
