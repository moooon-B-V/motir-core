import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { toJobRunDTO, toJobRunDlqDTO } from '@/lib/mappers/jobMappers';
import { withWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { replayDLQ as replayDlqInTx } from '@/lib/jobs/dlq';
import { isOwnerRole } from '@/lib/workspaces/roles';
import { ReplayForbiddenError, DlqEntryNotFoundError } from '@/lib/jobs/errors';
import type { JobRunDTO, JobRunDlqDTO, JobRunStatus } from '@/lib/dto/jobs';

// Read + replay surface for the operator dashboard (Story 1.6 · Subtask 1.6.5).
// The COUNTERPART to jobRunsService: that service is the trusted WRITER (it runs
// under withSystemContext because the job runtime has no workspace context),
// while this service is the tenant-facing READER + the owner-gated replay
// action. Every tenant read runs under withWorkspaceContext so the job_run /
// job_run_dlq RLS policies scope it to the active workspace; the system tab is
// the one withSystemContext read, reachable only by a PLATFORM_ADMIN_EMAIL
// operator (the page enforces that gate before calling listSystemRuns).
//
// Why a separate service file and not more methods on jobRunsService: the writer
// and the reader have opposite RLS contexts and opposite callers (runtime vs.
// HTTP request). Keeping them apart stops a future edit from accidentally giving
// a tenant read path the system-admin context.

/** Default dashboard page size (the 1.6.5 AC: 50 rows per page). */
export const JOBS_PAGE_SIZE = 50;

export interface ListRunsInput {
  workspaceId: string;
  userId: string;
  status?: JobRunStatus;
  limit: number;
  offset: number;
}

export interface ListDlqInput {
  workspaceId: string;
  userId: string;
  limit: number;
  offset: number;
}

export const jobsDashboardService = {
  /** A workspace's job runs (newest-first, optional status filter), as DTOs. */
  async listJobRuns(input: ListRunsInput): Promise<JobRunDTO[]> {
    const rows = await withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      (tx) =>
        jobRunRepository.listByWorkspace(
          input.workspaceId,
          { status: input.status, limit: input.limit, offset: input.offset },
          tx,
        ),
    );
    return rows.map(toJobRunDTO);
  },

  /** A workspace's dead-letter entries (newest-failure-first), as DTOs. */
  async listDLQ(input: ListDlqInput): Promise<JobRunDlqDTO[]> {
    const rows = await withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      (tx) =>
        jobRunDlqRepository.listByWorkspace(
          input.workspaceId,
          { limit: input.limit, offset: input.offset },
          tx,
        ),
    );
    return rows.map(toJobRunDlqDTO);
  },

  /** Count of NOT-yet-replayed DLQ entries (the tab-badge number). */
  async countDLQ(input: { workspaceId: string; userId: string }): Promise<number> {
    return withWorkspaceContext({ userId: input.userId, workspaceId: input.workspaceId }, (tx) =>
      jobRunDlqRepository.countActiveByWorkspace(input.workspaceId, tx),
    );
  },

  /**
   * Every run across all workspaces, INCLUDING untenanted system rows. Runs
   * under withSystemContext (the only context whose RLS branch admits null-
   * workspace rows). The CALLER must verify the requester is a platform admin
   * before invoking this — the service trusts that gate (same shape as the
   * workspace settings page resolving membership before listMembers).
   */
  async listSystemRuns(input: {
    status?: JobRunStatus;
    limit: number;
    offset: number;
  }): Promise<JobRunDTO[]> {
    const rows = await withSystemContext((tx) =>
      jobRunRepository.listAll(
        { status: input.status, limit: input.limit, offset: input.offset },
        tx,
      ),
    );
    return rows.map(toJobRunDTO);
  },

  /**
   * Replay a dead-lettered job. Owner-gated: re-checks the caller's role
   * server-side (the disabled UI button is a hint, not the gate) and refuses a
   * cross-workspace / unknown id. Runs the whole flow in ONE
   * withWorkspaceContext transaction so (a) the membership read sees the RLS
   * GUCs, and (b) the DLQ read + the replayedAt stamp share a tenant-scoped tx.
   * Delegates the actual re-emit + stamp to lib/jobs/dlq.ts (1.6.4).
   */
  async replayDLQ(input: {
    dlqId: string;
    workspaceId: string;
    userId: string;
  }): Promise<JobRunDlqDTO> {
    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        const membership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
          input.userId,
          input.workspaceId,
          tx,
        );
        if (!isOwnerRole(membership?.role)) {
          throw new ReplayForbiddenError(input.userId, input.workspaceId);
        }

        // Defense-in-depth: in dev/CI the superuser bypasses RLS, so findById
        // could return another workspace's row. Re-assert tenancy explicitly so
        // an owner of workspace A can never replay workspace B's entry by id.
        const entry = await jobRunDlqRepository.findById(input.dlqId, tx);
        if (!entry || entry.workspaceId !== input.workspaceId) {
          throw new DlqEntryNotFoundError(input.dlqId);
        }

        const result = await replayDlqInTx(input.dlqId, tx);

        // Audit trail for a privileged, security-relevant action (warn-level so
        // it surfaces in log aggregation). A durable audit-log table is future
        // Epic-6 work (PRODECT_FINDINGS #36); a structured server log keeps the
        // replay traceable in the meantime.
        console.warn(
          '[jobs.replay]',
          JSON.stringify({
            dlqId: input.dlqId,
            workspaceId: input.workspaceId,
            actorUserId: input.userId,
            functionId: entry.functionId,
            eventName: entry.eventName,
          }),
        );

        return result;
      },
    );
  },
};
