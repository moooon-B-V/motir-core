import { type CiRunnerProvisioningIntent, type Prisma } from '@/generated/prisma/client';

// Data access for the runner-fleet provisioning INTENTS (Story MOTIR-1916 ·
// MOTIR-1920). Single-op methods only (CLAUDE.md 4-layer); every write requires
// a `tx`, and the reads that guard a write take one too.

/** The intent lifecycle. MOTIR-1920 only ever writes `pending`; the transitions
 *  out of it belong to the provisioner (MOTIR-1921) and the gate (MOTIR-1922),
 *  which extend this vocabulary rather than migrate an enum. */
export const CI_RUNNER_INTENT_PENDING = 'pending';
/** CLAIMED by a provisioner: the JIT config is being minted and a container
 *  booted. The claim itself is what this status IS — see {@link claimPending}. */
export const CI_RUNNER_INTENT_PROVISIONING = 'provisioning';
/** The container is up and holding a registered runner. The state the reaper
 *  ages containers out of. */
export const CI_RUNNER_INTENT_RUNNING = 'running';
/** Terminal: the container ran and was torn down. */
export const CI_RUNNER_INTENT_COMPLETED = 'completed';
/** Terminal: no runner ever served this job, and nothing is still running for
 *  it. `teardownReason` says which path got here. */
export const CI_RUNNER_INTENT_FAILED = 'failed';

/** The statuses that mean "a container may still exist for this intent" — the
 *  reaper's and the in-flight count's window. */
export const CI_RUNNER_INTENT_IN_FLIGHT: readonly string[] = [
  CI_RUNNER_INTENT_PROVISIONING,
  CI_RUNNER_INTENT_RUNNING,
];

/** What a provisioner records once the container is up. */
export interface CiRunnerBootRecord {
  containerProvider: string;
  containerId: string;
  containerRegion: string;
  githubRunnerId: number | null;
  runnerName: string | null;
  bootedAt: Date;
}

/** What a provisioner records once the container is gone. */
export interface CiRunnerSettleRecord {
  status: string;
  teardownReason: string | null;
  settledAt: Date;
  failureDetail: string | null;
  startedAt?: Date | null;
  bootLatencyMs?: number | null;
}

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

  /** One intent by id, whatever its status. */
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent | null> {
    return tx.ciRunnerProvisioningIntent.findUnique({ where: { id } });
  },

  /**
   * CLAIM a pending intent — an atomic compare-and-set from `pending` to
   * `provisioning`, returning whether THIS caller won.
   *
   * ⚠️ THE `status: PENDING` PREDICATE IS THE CONCURRENCY GUARD, not decoration.
   * Two sweeps overlapping — a slow one still running when the next fires, or two
   * instances behind a load balancer — would otherwise both read the same pending
   * intent and both boot a runner for it. The second runner has no job to claim
   * (GitHub hands the job to whichever registers first) and would idle until its
   * timeout, billing the tenant's org for a container that did nothing. Postgres
   * evaluates the predicate under the row lock `UPDATE` takes, so exactly one
   * caller sees `count === 1`.
   *
   * A conditional UPDATE rather than `SELECT … FOR UPDATE` + write: there is
   * nothing to read between the two, so the compare-and-set is both shorter and
   * strictly harder to get wrong — no transaction has to be held open across the
   * GitHub and provider calls that follow.
   */
  async claimPending(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.ciRunnerProvisioningIntent.updateMany({
      where: { id, status: CI_RUNNER_INTENT_PENDING },
      data: { status: CI_RUNNER_INTENT_PROVISIONING },
    });
    return result.count === 1;
  },

  /**
   * The inverse of {@link claimPending} — hand a claimed slot back to the pending
   * pool, for a refusal about the ENVIRONMENT (unconfigured, rate-limited) or one
   * the admission gate makes AFTER taking the slot (`ci_credits_exhausted`).
   *
   * Guarded on `status = provisioning` for the same reason the claim is guarded
   * on `pending`: this must never resurrect an intent that has since booted or
   * settled. `settledAt` is cleared because a row going back into the queue has
   * not settled — leaving a stale instant there would make a re-queued intent
   * read, in the table and in every report over it, as one that already finished.
   */
  async releaseClaim(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.ciRunnerProvisioningIntent.updateMany({
      where: { id, status: CI_RUNNER_INTENT_PROVISIONING },
      data: { status: CI_RUNNER_INTENT_PENDING, settledAt: null, teardownReason: null },
    });
    return result.count === 1;
  },

  /**
   * Record the GitHub runner a JIT mint just registered — BEFORE the container
   * exists.
   *
   * ⚠️ THE ORDERING IS THE POINT, not an implementation detail. §7.4's verified
   * finding is that `generate-jitconfig` registers the runner at MINT time: the
   * `201` returns a runner row before any container is created. So between the
   * mint and the boot there is a window in which GitHub holds a registered runner
   * and Motir holds nothing — and a crash in that window leaves a dangling
   * registered runner NOBODY CAN NAME, because the only id was in the dead
   * process's memory. Writing the id first closes it: the stale-claim sweep reads
   * this column and de-registers.
   */
  async recordMintedRunner(
    id: string,
    data: { githubRunnerId: number; runnerName: string },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.update({
      where: { id },
      data: { githubRunnerId: data.githubRunnerId, runnerName: data.runnerName },
    });
  },

  /**
   * Intents CLAIMED but never booted, older than `claimedBefore` — the
   * stale-claim sweep's read.
   *
   * These are the crash-in-the-window rows above: status `provisioning`, no
   * container. They are found by `updatedAt` because the claim is the last thing
   * that touched them, and they carry the `githubRunnerId` that has to be
   * de-registered.
   */
  async listStaleClaims(
    claimedBefore: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: {
        status: CI_RUNNER_INTENT_PROVISIONING,
        containerId: null,
        updatedAt: { lt: claimedBefore },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  },

  /** Record the container this intent booted, and flip it to `running`. Written
   *  as ONE statement so a handle never exists without the status that tells the
   *  reaper to watch it. */
  async recordBoot(
    id: string,
    data: CiRunnerBootRecord,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.update({
      where: { id },
      data: {
        status: CI_RUNNER_INTENT_RUNNING,
        containerProvider: data.containerProvider,
        containerId: data.containerId,
        containerRegion: data.containerRegion,
        githubRunnerId: data.githubRunnerId,
        runnerName: data.runnerName,
        bootedAt: data.bootedAt,
      },
    });
  },

  /** Record when the container was observed running, and the boot latency that
   *  implies — ADR §6's budget made measurable. */
  async recordStarted(
    id: string,
    startedAt: Date,
    bootLatencyMs: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.update({
      where: { id },
      data: { startedAt, bootLatencyMs },
    });
  },

  /** Move an intent to a terminal status with the reason it got there. */
  async settle(
    id: string,
    data: CiRunnerSettleRecord,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.ciRunnerProvisioningIntent.update({
      where: { id },
      data: {
        status: data.status,
        teardownReason: data.teardownReason,
        settledAt: data.settledAt,
        failureDetail: data.failureDetail,
        ...(data.startedAt === undefined ? {} : { startedAt: data.startedAt }),
        ...(data.bootLatencyMs === undefined ? {} : { bootLatencyMs: data.bootLatencyMs }),
      },
    });
  },

  /**
   * Intents still holding a container — the REAPER's read, and the read that
   * recovers attribution for a container the provider reports.
   *
   * Keyed on `containerId` rather than on the intent id because the reaper starts
   * from what the PROVIDER says exists, which is the only source that is still
   * right after the orchestrator has crashed.
   */
  async findByContainerId(
    provider: string,
    containerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent | null> {
    return tx.ciRunnerProvisioningIntent.findFirst({
      where: { containerProvider: provider, containerId },
    });
  },

  /**
   * How many runners are IN FLIGHT for one project — the per-project cap's
   * count (MOTIR-1922).
   *
   * ⚠️ Read UNDER THE PROJECT'S ADMISSION LOCK and inside the same transaction as
   * the claim it guards, never on its own: it is the read half of a read-derived
   * write, and a count taken outside the lock is a snapshot two racers can both
   * act on. See `ciFleetAdmissionLockRepository.lockScope`.
   *
   * "In flight" is `provisioning` + `running` — the same window the reaper uses,
   * and the reason completion frees a slot with no extra bookkeeping: settling an
   * intent to `completed`/`failed` drops it out of this set in the same write
   * that ends the container.
   */
  async countInFlightForProject(projectId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.ciRunnerProvisioningIntent.count({
      where: { projectId, status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
    });
  },

  /**
   * How many CI RUNNERS are in flight across the whole fleet — the `ci_runner`
   * term of the cross-workload ceiling (MOTIR-1922 / ADR §9.1, generalized by
   * MOTIR-1997).
   *
   * Unscoped ON PURPOSE: no workspace, no org, no project. The invoice this
   * bounds is Motir's own, and a per-tenant count cannot see the failure mode —
   * an unbounded number of projects, each individually under its own cap. It is
   * read under the `fleet` admission lock, which every admission takes, so this
   * is the most contended read on the path and the one that lock exists for.
   *
   * ⚠️ THIS IS NO LONGER THE WHOLE CEILING, and calling it directly is how the
   * ceiling stops being a bound. Index containers (MOTIR-1981/1990) and hosted
   * agents (Epic 9) run on the same fleet and write no intent, so the number
   * that bounds the invoice is the UNION in `fleetCeilingService.census` — this
   * is one of its terms, registered as `ci_runner` in `lib/ciFleet/workloads.ts`.
   * Read the total from there.
   */
  async countInFlightFleetWide(tx: Prisma.TransactionClient): Promise<number> {
    return tx.ciRunnerProvisioningIntent.count({
      where: { status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
    });
  },

  /** Every intent whose container is still supposed to be alive. Used to settle
   *  the rows a reap destroyed, so the table cannot keep claiming a container
   *  exists after the sweeper has removed it. */
  async listInFlight(
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiRunnerProvisioningIntent[]> {
    return tx.ciRunnerProvisioningIntent.findMany({
      where: { status: { in: [...CI_RUNNER_INTENT_IN_FLIGHT] } },
      orderBy: { bootedAt: 'asc' },
      take: limit,
    });
  },
};
