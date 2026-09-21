import { defineJob } from '../defineJob';
import { resolveRetries } from '../retries';
import { sendEvent } from '../sendEvent';
import type { MonitorConnectionPollRequestedData } from '../types';

// THE MONITOR-ISSUE RECONCILER (Story MOTIR-4929 · Subtask MOTIR-5581) — the
// clock behind `monitorIngestionService.pollConnection`, which turns a bound
// error monitor's new issues into `bug` work items.
//
// The policy is all in the service — the watermark, the level filter, the
// reconcile, the recorded outcome. This file is the SCHEDULE, the FAN-OUT and
// the FAILURE PATH, the split `pullRequestReconcile` makes.
//
// ── Two definitions ────────────────────────────────────────────────────────
//   1. the TICK — lists every pollable binding and emits one
//      `monitor/connection.poll-requested` event each;
//   2. the PER-CONNECTION run — one isolated run per binding, so one
//      connection's failure (a revoked credential, a provider outage, a bug in
//      one issue) cannot abort another's. Separate runs make that structural
//      rather than a try/catch someone can remove, and each retries,
//      dead-letters and is recorded on its own.
//
// ── The asynchronous-work obligations ─────────────────────────────────────
//   · IDEMPOTENCY — `<connectionId>:<tick run id>` on the per-connection event,
//     so a retried tick cannot enqueue a second poll of one binding for one
//     tick. Beyond that a second poll is safe by construction: the issue claim
//     is a row lock and the watermark advance is a compare-and-set.
//   · FAILURE — transient retries, then the TERMINAL write onto the binding, then
//     the engine's dead-letter row and alert. A provider REFUSAL is not a failure
//     here: the poll records it and returns, so a revoked credential does not
//     burn retries.
//   · ORDERING — none assumed. A slow run and the next tick's may overlap on one
//     binding, and the result is still correct.
//   · SIDE EFFECTS — the only external call is a provider READ inside the poll;
//     filing is a database write, so there is no commit-then-effect split.

/**
 * Every 30 minutes, ON the cluster (`lib/jobs/schedules.ts`'s
 * `SCHEDULE_CLUSTER_MINUTES`) — both clustered minutes, so it opens no new
 * wake-minute and the quiet gap is untouched.
 *
 * ⚠️ NOT TEN MINUTES, which is what the plan first assumed. The cluster
 * invariant is that every tick wakes the compute, and a job needing finer
 * granularity than 30 minutes is a decision to bring separately
 * (`tests/jobs/schedule-cluster.test.ts` fails the build on a new wake-minute).
 * The worst case for an error reaching the board is 30 minutes — for turning a
 * production error into PLANNED work that is not a paging SLA, and alerting is
 * MOTIR-3765's, not this story's.
 */
export const MONITOR_ISSUE_RECONCILE_CRON = '0,30 * * * *';

/**
 * When a binding's last poll is older than this, the scheduler has stopped
 * reaching it — TWO missed ticks. The Monitoring room reads it to say so on the
 * row (MOTIR-5582), because a reconciler that silently stops looks exactly like
 * a quiet week: the failure this epic exists to make visible (MOTIR-4918).
 */
export const MONITOR_ISSUE_RECONCILE_OVERDUE_MS = 60 * 60 * 1000;

/** The per-connection run's retry intent: a provider that did not answer is a
 *  network failure, and a few attempts with backoff is right. */
export const MONITOR_CONNECTION_POLL_RETRY_POLICY = 'transient' as const;

/** Total attempts, first included — what `job_queue.max_attempts` stores. */
export const MONITOR_CONNECTION_POLL_MAX_ATTEMPTS =
  resolveRetries({ retryPolicy: MONITOR_CONNECTION_POLL_RETRY_POLICY }) + 1;

export const monitorIssueReconcileTick = defineJob(
  {
    id: 'system.monitor-issue-reconcile',
    cron: MONITOR_ISSUE_RECONCILE_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    const connections = await ctx.step.run('list-pollable-connections', () =>
      services.monitorIngestion.listPollableConnections(),
    );
    if (connections.length === 0) return { dispatched: 0 };

    // STRICT: a failed enqueue belongs to the step, and letting it propagate
    // buys the engine's retry. The per-connection idempotency key is what keeps
    // that retry from polling a binding twice for this tick.
    await ctx.step.run('dispatch-polls', async () => {
      for (const connection of connections) {
        const data: MonitorConnectionPollRequestedData = {
          workspaceId: connection.workspaceId,
          connectionId: connection.id,
          idempotencyKey: `${connection.id}:${ctx.runId}`,
        };
        await sendEvent('monitor/connection.poll-requested', data, { strict: true });
      }
      return { dispatched: connections.length };
    });

    return { dispatched: connections.length };
  },
);

export const monitorConnectionPoll = defineJob(
  {
    id: 'monitor/connection.poll-requested',
    retryPolicy: MONITOR_CONNECTION_POLL_RETRY_POLICY,
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const { connectionId } = ctx.event.data as MonitorConnectionPollRequestedData;
    try {
      // `poll-v3` since MOTIR-5983 added the backfill sweep's two counts to the
      // summary (`poll-v2` since MOTIR-5729 added `refreshed`); each old id is
      // retired in `tests/jobs/stepResultShapePins.ts` with its reason.
      return await ctx.step.run('poll-v3', () =>
        services.monitorIngestion.pollConnection(connectionId),
      );
    } catch (err) {
      // ⚠️ THE TERMINAL FAILURE IS WRITTEN WHERE A PERSON LOOKS. The engine's
      // terminal hook (`recordEngineTerminalFailure`) writes the `failed` ledger
      // row and the dead-letter row, and has no per-job extension — and a
      // dead-letter row is the surface MOTIR-4918 proved nobody reads. So the
      // FINAL attempt (`attempt` is zero-indexed) records the failure on the
      // binding's row in the Monitoring room, then RETHROWS so the engine still
      // dead-letters it and fires its existing alert.
      if (ctx.attempt + 1 >= MONITOR_CONNECTION_POLL_MAX_ATTEMPTS) {
        await services.monitorIngestion.recordTerminalFailure(connectionId, err);
      }
      throw err;
    }
  },
);
