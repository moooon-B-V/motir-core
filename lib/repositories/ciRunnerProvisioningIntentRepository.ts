import { type CiRunnerProvisioningIntent, type Prisma } from '@prisma/client';

// Data access for the runner-fleet provisioning INTENTS (Story MOTIR-1916 ·
// MOTIR-1920). Single-op methods only (CLAUDE.md 4-layer); every write requires
// a `tx`, and the reads that guard a write take one too.

/** The intent lifecycle. MOTIR-1920 only ever writes `pending`; the transitions
 *  out of it belong to the provisioner (MOTIR-1921) and the gate (MOTIR-1922),
 *  which extend this vocabulary rather than migrate an enum. */
export const CI_RUNNER_INTENT_PENDING = 'pending';

export interface CiRunnerProvisioningIntentCreateInput {
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  githubRepoId: string | null;
  installationId: string;
  runId: string;
  runAttempt: number;
  jobId: string;
  jobName: string | null;
  workflowName: string | null;
  repoOwner: string;
  repoName: string;
  requestedLabels: string[];
  queuedAt: Date;
}

export const ciRunnerProvisioningIntentRepository = {
  /**
   * Record one queued job as a pending provisioning intent. The
   * `(run_id, run_attempt, job_id)` unique index is the real idempotency guard —
   * a webhook redelivery raises P2002 here, which the service translates to a
   * `duplicate` outcome. A RE-RUN (a new attempt) and every sibling job of the
   * same run each insert their own row, because each needs its own ephemeral
   * runner.
   */
  async create(
    data: CiRunnerProvisioningIntentCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent> {
    return tx.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: data.workspaceId,
        organizationId: data.organizationId,
        projectId: data.projectId,
        githubRepoId: data.githubRepoId,
        installationId: data.installationId,
        runId: data.runId,
        runAttempt: data.runAttempt,
        jobId: data.jobId,
        jobName: data.jobName,
        workflowName: data.workflowName,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        requestedLabels: data.requestedLabels,
        queuedAt: data.queuedAt,
        status: CI_RUNNER_INTENT_PENDING,
      },
    });
  },

  /**
   * The intent for one job of one run attempt, if it exists — the cheap
   * redelivery pre-check. NOT the correctness guard: two concurrent deliveries
   * would both miss it, and the unique index above is what guarantees once.
   */
  async findByJobKey(
    runId: string,
    runAttempt: number,
    jobId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent | null> {
    return tx.ciRunnerProvisioningIntent.findUnique({
      where: { runId_runAttempt_jobId: { runId, runAttempt, jobId } },
    });
  },

  /**
   * The oldest intents still awaiting a runner — the provisioner's (MOTIR-1921)
   * work queue, and the read that makes this table a seam rather than a
   * write-only log. Oldest-first by the job's own QUEUE time, not by insertion:
   * a redelivered or delayed webhook must not let a fresh job jump ahead of one
   * GitHub has already been holding.
   */
  async listPending(
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: { status: CI_RUNNER_INTENT_PENDING },
      orderBy: { queuedAt: 'asc' },
      take: limit,
    });
  },
};
