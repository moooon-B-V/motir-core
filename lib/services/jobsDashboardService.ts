import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { jobRunDlqRepository } from '@/lib/repositories/jobRunDlqRepository';
import { toJobRunDTO, toJobRunDlqDTO } from '@/lib/mappers/jobMappers';
import { emailDeliveryRepository } from '@/lib/repositories/emailDeliveryRepository';
import { withWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { replayDLQ as replayDlqInTx, type ReplayDLQResult } from '@/lib/jobs/dlq';
import { readReachRole } from '@/lib/workspaces/membershipGate';
import { isWorkspaceManager } from '@/lib/projects/roles';
import {
  ReplayForbiddenError,
  DlqEntryNotFoundError,
  SystemReplayForbiddenError,
  SystemReplayWorkspaceRowError,
} from '@/lib/jobs/errors';
import { isPlatformOperator } from '@/lib/jobs/platformOperator';
import type { JobRunDTO, JobRunDlqDTO, JobRunStatus, SystemDlqListDTO } from '@/lib/dto/jobs';

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

/**
 * How long a REPLAYED system dead letter stays on the System tab — long enough
 * to confirm the replay landed, short enough that the list stays a queue
 * (`design/jobs/design-notes.md` § System dead letters, MOTIR-8084).
 */
export const SYSTEM_DLQ_REPLAYED_WINDOW_DAYS = 7;

/**
 * A safety cap on each half of the System tab's dead-letter list. The tab has no
 * pager by design (the standing-depth filer keeps the unreplayed set small), so
 * this only bounds a pathological outage; the summary counts are the TRUE counts
 * and stay honest past it.
 */
export const SYSTEM_DLQ_LIST_CAP = 200;

export interface ListDlqInput {
  workspaceId: string;
  userId: string;
  limit: number;
  offset: number;
}

/**
 * Join each run to its message's delivery record (Bug MOTIR-3507 · Subtask
 * MOTIR-3517), in ONE extra query for the whole page.
 *
 * The join key is `idempotencyKey`, which is on the run ledger and on the
 * delivery row and indexed on both. It is deliberately NOT the engine's run id:
 * that id means different things on the two lanes (a `job_queue` cuid on the
 * Postgres engine, an Inngest ULID on the other), whereas the send key is the
 * payload's own and is identical either way.
 *
 * Runs with no key, and runs that are not `email.send`, are skipped before the
 * query — so a workspace whose jobs are all reindexes pays nothing for this.
 * `tx` is threaded from the caller's context binding, so the lookup is scoped
 * by the same RLS the runs read was.
 */
async function withDeliveries(
  runs: Awaited<ReturnType<typeof jobRunRepository.listByWorkspace>>,
  tx: Parameters<typeof emailDeliveryRepository.listByIdempotencyKeys>[1],
): Promise<JobRunDTO[]> {
  const keys = [
    ...new Set(
      runs
        .filter((run) => run.functionId === EMAIL_SEND_FUNCTION_ID)
        .map((run) => run.idempotencyKey)
        .filter((key): key is string => key !== null),
    ),
  ];
  const deliveries = await emailDeliveryRepository.listByIdempotencyKeys(keys, tx);
  const byKey = new Map(
    deliveries
      .filter((row) => row.idempotencyKey !== null)
      .map((row) => [row.idempotencyKey as string, row]),
  );
  return runs.map((run) =>
    toJobRunDTO(run, run.idempotencyKey === null ? null : (byKey.get(run.idempotencyKey) ?? null)),
  );
}

/** The one job whose runs carry a delivery record. */
const EMAIL_SEND_FUNCTION_ID = 'email.send';

export const jobsDashboardService = {
  /** A workspace's job runs (newest-first, optional status filter), as DTOs. */
  async listJobRuns(input: ListRunsInput): Promise<JobRunDTO[]> {
    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        const rows = await jobRunRepository.listByWorkspace(
          input.workspaceId,
          { status: input.status, limit: input.limit, offset: input.offset },
          tx,
        );
        return withDeliveries(rows, tx);
      },
    );
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
    return withSystemContext(async (tx) => {
      const rows = await jobRunRepository.listAll(
        { status: input.status, limit: input.limit, offset: input.offset },
        tx,
      );
      // The system view is the one place an UNTENANTED delivery is visible —
      // a password reset carries a null workspace on both the run and its
      // delivery row, so only this binding's RLS branch admits either.
      return withDeliveries(rows, tx);
    });
  },

  /**
   * The dead letters with NO workspace — what every `system.*` job writes when
   * it exhausts its retries (MOTIR-8083). Not yet replayed first, then those
   * replayed within {@link SYSTEM_DLQ_REPLAYED_WINDOW_DAYS}; each group newest
   * failure first. Runs under withSystemContext (the only RLS branch that admits
   * an untenanted row), so, like {@link listSystemRuns}, the CALLER must have
   * verified the requester is the platform operator before calling this.
   */
  async listSystemDlq(now: Date = new Date()): Promise<SystemDlqListDTO> {
    const since = new Date(now.getTime() - SYSTEM_DLQ_REPLAYED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return withSystemContext(async (tx) => {
      const [unreplayed, replayed, waiting, replayedRecently] = await Promise.all([
        jobRunDlqRepository.listSystemUnreplayed(SYSTEM_DLQ_LIST_CAP, tx),
        jobRunDlqRepository.listSystemReplayedSince(since, SYSTEM_DLQ_LIST_CAP, tx),
        jobRunDlqRepository.countSystemUnreplayed(tx),
        jobRunDlqRepository.countSystemReplayedSince(since, tx),
      ]);
      return {
        rows: [...unreplayed, ...replayed].map(toJobRunDlqDTO),
        waiting,
        replayedRecently,
      };
    });
  },

  /**
   * The OPERATOR's replay of a dead letter that has no workspace (MOTIR-8083) —
   * the door `replayDLQ` below structurally cannot be, because that one runs in
   * the caller's workspace and asks for a row of that workspace.
   *
   * ⚠️ THIS RUNS UNDER `withSystemContext`, WHICH BYPASSES TENANT RLS, so its two
   * refusals are the whole of its safety and both are enforced HERE, not in the
   * Server Action or the UI (the hidden button is a hint, not the gate):
   *   1. the caller must be the platform operator (`PLATFORM_ADMIN_EMAIL`) —
   *      the same comparison that shows them the System tab;
   *   2. the row must have `workspace_id IS NULL`. A workspace's row keeps its
   *      manager-gated door; letting the operator door take it would make this
   *      a way to replay ANY tenant's dead letter by id.
   * An unknown id answers the same not-found the workspace door does.
   *
   * ONE transaction, the replay + the `replayedAt` stamp together, delegating the
   * re-emit to lib/jobs/dlq.ts so the `:replay:<dlqId>` key, the
   * stamp-only-after-publish ordering and the already-replayed outcome (MOTIR-3730)
   * are the ones the workspace door has.
   */
  async replaySystemDLQ(input: {
    dlqId: string;
    userId: string;
    userEmail: string;
  }): Promise<ReplayDLQResult> {
    if (!isPlatformOperator(input.userEmail)) {
      throw new SystemReplayForbiddenError(input.userId);
    }
    return withSystemContext(async (tx) => {
      const entry = await jobRunDlqRepository.findById(input.dlqId, tx);
      if (!entry) throw new DlqEntryNotFoundError(input.dlqId);
      if (entry.workspaceId !== null) throw new SystemReplayWorkspaceRowError(input.dlqId);

      const result = await replayDlqInTx(input.dlqId, tx);

      // The same warn-level audit line the workspace door writes; `workspaceId:
      // null` is what tells the two doors apart in the log.
      console.warn(
        '[jobs.replay]',
        JSON.stringify({
          dlqId: input.dlqId,
          workspaceId: null,
          actorUserId: input.userId,
          functionId: entry.functionId,
          eventName: entry.eventName,
          door: 'system',
          outcome: result.outcome,
        }),
      );

      return result;
    });
  },

  /**
   * Replay a dead-lettered job. Owner-gated: re-checks the caller's role
   * server-side (the disabled UI button is a hint, not the gate) and refuses a
   * cross-workspace / unknown id. Runs the whole flow in ONE
   * withWorkspaceContext transaction so (a) the membership read sees the RLS
   * GUCs, and (b) the DLQ read + the replayedAt stamp share a tenant-scoped tx.
   * Delegates the actual re-emit + stamp to lib/jobs/dlq.ts (1.6.4).
   *
   * ⚠️ RETURNS A DISCRIMINATED RESULT, and an ALREADY-REPLAYED row is a normal
   * one (MOTIR-3730) — not an error, and not something the route may only learn
   * from a log line. It used to be a raw `P2002` thrown straight through this
   * method into the Server Action.
   */
  async replayDLQ(input: {
    dlqId: string;
    workspaceId: string;
    userId: string;
  }): Promise<ReplayDLQResult> {
    return withWorkspaceContext(
      { userId: input.userId, workspaceId: input.workspaceId },
      async (tx) => {
        // The workspace MANAGER replays (MOTIR-6462): a legacy `owner` or `admin`
        // resolves to it, and so does the org Owner or an org Admin, who may hold
        // no membership — the same composed role the pane reads for its button.
        const role = await readReachRole(input.userId, input.workspaceId, tx);
        if (!isWorkspaceManager(role)) {
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
            // A second click enqueues nothing, and the audit line has to say so
            // — otherwise two identical entries read as two re-runs.
            outcome: result.outcome,
          }),
        );

        return result;
      },
    );
  },
};
