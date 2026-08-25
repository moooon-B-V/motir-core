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
// stops — so a transient DB blip is worth Inngest's full retry budget. Bounded per
// run (batch x max-batches in `rateLimitService`), so a backlog drains over
// several days rather than locking a large slice of a hot table in one pass.

/** 04:10 every day — off-peak, clear of attachmentGc (03:30) and the 09:00 health check. */
export const RATE_LIMIT_SWEEP_CRON = '10 4 * * *';

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
