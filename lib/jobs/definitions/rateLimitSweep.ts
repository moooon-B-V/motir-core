import { defineJob } from '../defineJob';

// Rate-limit counter sweep (Subtask 8.5.9 / MOTIR-1165) — the lifecycle half of
// the shared limiter, scheduled on the 1.6 cron primitive like `attachmentGc`.
//
// WHY IT IS NOT OPTIONAL. `rate_limit_counter` gains a row per (caller, window)
// and NOTHING in the request path ever deletes one: the window resets by moving
// to a NEW row, which is what makes the increment a single atomic statement with
// no reset logic. That design choice is exactly what makes the sweep load-bearing
// — without it the table grows by every limited request forever and the limiter
// becomes the product's largest table, then the slowest one, which would flip the
// ADR §6 decision on its own p99 trigger for reasons that have nothing to do with
// Postgres. Pinned in `docs/decisions/production-service-stack.md` §6.
//
// System-scoped: the counters span workspaces (and the pre-auth ones belong to no
// workspace at all — the table deliberately carries no `workspace_id`, ADR §7), so
// the ledger row is untenanted like every `system.*` job.
//
// `retryPolicy: 'idempotent'`: the sweep converges on re-run by construction —
// deleted rows stop matching `expires_at < now`, and a pass that finds nothing
// stops — so a transient DB blip is worth the policy's full retry budget. Bounded per
// run (batch x max-batches in `rateLimitService`), so a backlog drains over
// several days rather than locking a large slice of a hot table in one pass.

/** 04:00 every day — off-peak, and second in the nightly table-walk cascade
 *  (03:30 attachment GC → 04:00 here → 04:30 automation retention → 05:00
 *  code-graph offboard).
 *
 *  ⚠️ RE-TIMED :10 → :00 (MOTIR-3314). Nothing about this job's cadence or its
 *  cost changed; the MINUTE moved onto `SCHEDULE_CLUSTER_MINUTES` so it stops
 *  opening a wake-minute of its own. What it gave up is ten minutes of when;
 *  what it bought is that the separation from its neighbours is now by HOUR
 *  rather than by minute, which is strictly MORE separation than the old
 *  04:10/04:15 pair had — those were five minutes apart. */
export const RATE_LIMIT_SWEEP_CRON = '0 4 * * *';

export const rateLimitSweep = defineJob(
  {
    id: 'system.rate-limit-sweep',
    cron: RATE_LIMIT_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    return ctx.step.run('sweep-expired-counters', () => services.rateLimit.sweepExpired());
  },
);
