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
};
