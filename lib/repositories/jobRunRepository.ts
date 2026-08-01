import { Prisma, type JobRun, type JobRunStatus } from '@prisma/client';

// Data access for the job_run ledger (Story 1.6 · Subtask 1.6.2). Single-op
// methods only; writes require `tx` (the 4-layer contract). jobRunsService
// owns the transactions and the DTO mapping.
export const jobRunRepository = {
  /** Read one run by id. Used inside the finish transaction to read startedAt. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobRun | null> {
    return tx.jobRun.findUnique({ where: { id } });
  },

  /**
   * Find the still-`running` row for a given (function, event), newest first.
   * This is how the TERMINAL-FAILURE path (1.6.6) correlates the failure back
   * to the `running` row that `recordStart` wrote: the failure is reported by
   * Inngest's `onFailure` handler — a SEPARATE invocation from the run that
   * created the row — which carries the original event but not the row id. The
   * `@@index([eventId])` exists precisely for this lookup. Read inside the
   * failure transaction, so it takes `tx`.
   */
  async findRunningByEventId(
    eventId: string,
    functionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun | null> {
    return tx.jobRun.findFirst({
      where: { eventId, functionId, status: 'running' },
      orderBy: { startedAt: 'desc' },
    });
  },

  /**
   * Insert the initial `running` row. Uses the UNCHECKED create input (scalar
   * `workspaceId` FK) rather than a `workspace: { connect }` relation: the job
   * runtime writes under the system-admin context with NO workspace context, so
   * a `connect` — which issues a SELECT on `workspace` to validate the related
   * row — would be hidden by the workspace table's RLS and fail. The scalar FK
   * sets the column directly; referential integrity is still enforced by the
   * Postgres FK constraint (FK checks are not subject to RLS).
   */
  async create(
    data: Prisma.JobRunUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun> {
    return tx.jobRun.create({ data });
  },

  /** Patch a run on completion (status / finishedAt / durationMs / failure). */
  async update(
    id: string,
    data: Prisma.JobRunUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun> {
    return tx.jobRun.update({ where: { id }, data });
  },

  /**
   * The migrate-onboarding INDEX-readiness poll (Story 7.15 · MOTIR-931): the
   * newest SUCCEEDED `system.code-graph-index` run for this workspace whose
   * ledger `output.repoRef` is the connected repo. The code-graph index job is
   * fire-and-forget (enqueued by the GitHub grant flow, `enqueueCodeGraphIndex`)
   * and is NOT a motir-ai JobKind, so its terminal state is read HERE from the
   * job_run ledger — the durable completion signal the migrate wizard's `index`
   * step waits on (it "waits, does not index"). Matching `output.repoRef` keeps a
   * stale index of a DIFFERENT repo from counting. Takes `tx` so it runs under
   * the caller's `withWorkspaceContext` (the job_run RLS policy scopes it).
   */
  async findSucceededCodeGraphIndex(
    workspaceId: string,
    repoRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun | null> {
    return tx.jobRun.findFirst({
      where: {
        workspaceId,
        functionId: 'system.code-graph-index',
        status: 'succeeded',
        output: { path: ['repoRef'], equals: repoRef },
      },
      orderBy: { finishedAt: 'desc' },
    });
  },

  /**
   * The FIRST-INDEX recovery read (MOTIR-1961): every repo of this workspace
   * that ALREADY has a code graph — the `output.repoRef` of each SUCCEEDED
   * `system.code-graph-index` run. The set form of
   * {@link findSucceededCodeGraphIndex}, for the enqueue gate that must decide
   * "has this repo ever been indexed?" for a WHOLE repo set in one round-trip
   * instead of N per-repo reads.
   *
   * Scope note: this answers "a first graph EXISTS", not "the graph is FRESH".
   * Staleness (graph commit vs the default-branch head) is MOTIR-1754/1766's
   * axis and deliberately not read here — a repo that never got a first graph
   * cannot be stale, so the two questions never overlap.
   *
   * Takes `tx`: run it under `withWorkspaceContext` (the RLS policy scopes it)
   * or `withSystemContext` (the grant/webhook paths, which have no active
   * workspace — the policy's system-admin branch admits them).
   */
  async listSucceededCodeGraphIndexRepoRefs(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.jobRun.findMany({
      where: {
        workspaceId,
        functionId: 'system.code-graph-index',
        status: 'succeeded',
      },
      select: { output: true },
    });
    const refs = new Set<string>();
    for (const row of rows) {
      const output = row.output as { repoRef?: unknown } | null;
      // A succeeded run that indexed NOTHING (`{ indexed: false, reason }` —
      // the installation/workspace vanished, or the workspace had no projects)
      // carries no `repoRef` and must NOT count as an index.
      if (output && typeof output.repoRef === 'string') refs.add(output.repoRef);
    }
    return [...refs];
  },

  /**
   * The migrate-onboarding INDEX-progress read (Story 7.15 · MOTIR-934): is a
   * `system.code-graph-index` run CURRENTLY indexing ANY repo for this workspace?
   * The wizard's Index step shows an aggregate "indexing in progress" spinner when
   * this returns a row. Unlike {@link findSucceededCodeGraphIndex} this is NOT
   * keyed by `repoRef`: a `running` row has no `output.repoRef` (the index job
   * writes `output` only on success), so the ledger cannot say WHICH repo a running
   * row belongs to — only that one is in flight. Per-repo status is therefore
   * `indexed` (a succeeded row matches) vs `pending` (not yet); the running flag is
   * aggregate. Takes `tx` so it runs under the caller's `withWorkspaceContext`.
   */
  async findRunningCodeGraphIndexForWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun | null> {
    return tx.jobRun.findFirst({
      where: {
        workspaceId,
        functionId: 'system.code-graph-index',
        status: 'running',
      },
      orderBy: { startedAt: 'desc' },
    });
  },

  /**
   * Dashboard read (1.6.5): a workspace's runs, newest-first, optionally
   * filtered by status, with limit/offset paging. Takes `tx` because the read
   * runs inside withWorkspaceContext so the job_run RLS policy scopes it; the
   * explicit `where.workspaceId` is the in-query scope that also holds in
   * dev/CI where the superuser bypasses RLS (defense-in-depth, mirrors
   * workspaceMembershipRepository.findMembersByWorkspace). Serves the
   * `[workspaceId, startedAt desc]` / `[workspaceId, status, startedAt desc]`
   * indexes from the 1.6.2 schema.
   */
  async listByWorkspace(
    workspaceId: string,
    opts: { status?: JobRunStatus; limit: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRun[]> {
    return tx.jobRun.findMany({
      where: { workspaceId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { startedAt: 'desc' },
      take: opts.limit,
      skip: opts.offset,
    });
  },

  /**
   * System-tab read (1.6.5): every run across all workspaces INCLUDING the
   * untenanted system rows (workspace_id IS NULL). No workspace filter — the
   * caller MUST run this under withSystemContext (the only context whose RLS
   * branch admits null-workspace rows), and the dashboard only reaches it for a
   * PLATFORM_ADMIN_EMAIL operator. Newest-first, paged.
   */
  async listAll(
    opts: { status?: JobRunStatus; limit: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRun[]> {
    return tx.jobRun.findMany({
      where: { ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { startedAt: 'desc' },
      take: opts.limit,
      skip: opts.offset,
    });
  },

  /**
   * Newest `started_at` per event name, across ALL workspaces (MOTIR-1970).
   *
   * The schedule-health check asks "when did each cron job last actually run?",
   * which is one aggregate over the whole ledger rather than N per-job reads —
   * hence a single `groupBy`. Like `listAll` it has no workspace filter, so the
   * caller MUST supply a `withSystemContext` tx (the only RLS branch that admits
   * the untenanted `workspace_id IS NULL` rows every `system.*` job writes).
   *
   * Keyed on `eventName`, not `functionId`, because that is what identifies a
   * SCHEDULED run: `defineJob` records a cron run's event name as the synthetic
   * `scheduled.{id}`, so keying on it counts only genuine cron ticks and never a
   * manual replay of the same function from the DLQ.
   */
  async findLatestStartedAtByEventNames(
    eventNames: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ eventName: string; latestStartedAt: Date }>> {
    const rows = await tx.jobRun.groupBy({
      by: ['eventName'],
      where: { eventName: { in: eventNames } },
      _max: { startedAt: true },
    });
    // `_max.startedAt` types as nullable because Prisma cannot know the column
    // is not — but `started_at` is NOT NULL and `groupBy` never returns an empty
    // group, so a returned row always has a max. Asserting it here keeps the
    // impossible case out of the caller as a branch it could never exercise.
    return rows.map((row) => ({ eventName: row.eventName, latestStartedAt: row._max.startedAt! }));
  },
};
