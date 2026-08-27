import { defineJob } from '../defineJob';

// THE CODE-GRAPH OFFBOARDING SWEEP (Story MOTIR-2192 · Subtask MOTIR-2168 ·
// `docs/decisions/code-graph-index-fleet.md` §14.5) — the clock that makes
// Decision 10's retention window real.
//
// §14 commits the product to removing a tenant's derived code graph after a
// stated window. MOTIR-2166 enqueues due rows from the four lifecycle triggers;
// MOTIR-2165 built motir-ai's `POST /v1/code-graph/offboard`, which removes the
// snapshot, the local root and the coordination row in that order. This job is
// what joins them — and until it shipped, both halves were green, reviewable and
// completely inert (`notes.html` #206).
//
// SYSTEM-scoped, like every other retention sweep here (`system.attachment-gc`,
// `system.automation-retention-sweep`): the queue spans workspaces — by design, a
// row OUTLIVES the workspace it names — so it runs under `withSystemContext`
// inside the service, and its ledger row is untenanted.
//
// `retryPolicy: 'idempotent'`: the sweep converges on re-run by construction. A
// confirmed removal deletes its queue row, so it stops matching `findDue`; motir-ai's
// endpoint is itself idempotent (`DeleteObjects` over a prefix, `rm -rf`,
// `deleteMany`), so a re-run against a partially-removed repo is a clean no-op
// with zero counts. A transient blip is therefore worth Inngest's full 5-attempt
// budget.
//
// ⚠️ THE RETRY IS THE QUEUE, AND THAT IS THE WHOLE DESIGN. The service deletes a
// row ONLY on a successful response, so a motir-ai outage simply leaves the row
// due for the next tick. Do not add an attempt counter, a dead-letter table or a
// backoff here: each is state that can disagree with the queue, for a job that is
// allowed to be slow. What must never happen is the inverse — retiring the row
// before the removal is confirmed, which turns a transient outage into permanent
// retention with no record that anything was owed.

/**
 * 05:00 every day — off-peak, and LAST in the nightly table-walk cascade: 03:30
 * `system.attachment-gc`, 04:00 `system.rate-limit-sweep`, 04:30
 * `system.automation-retention-sweep`, then this one. All of those walk large
 * tables and this one additionally makes an external call per row, so they are
 * still deliberately not stacked on one cold start.
 *
 * ⚠️ RE-TIMED 04:45 → 05:00 (MOTIR-3314), and the "not sharing a slot" property
 * this comment protects SURVIVES INTACT — separation just moved from the minute
 * axis to the HOUR axis. That is the whole reason the cluster has two slots
 * rather than one (`lib/jobs/schedules.ts`): a nightly cascade can be spread a
 * full hour apart while every member still lands on a clustered minute, so the
 * spreading costs no extra wake. Each of the four now has an hour to itself,
 * where 04:15 and 04:45 were thirty minutes apart and 04:10 and 04:15 were five.
 */
export const CODE_GRAPH_OFFBOARD_SWEEP_CRON = '0 5 * * *';

export const codeGraphOffboardSweep = defineJob(
  {
    id: 'system.code-graph-offboard-sweep',
    cron: CODE_GRAPH_OFFBOARD_SWEEP_CRON,
    catchUp: 'latest',
    retryPolicy: 'idempotent',
  },
  async (ctx, services) => {
    // The per-run summary IS the return value, persisted on the run's `job_run`
    // ledger row — so "what did we actually delete for this tenant" is answerable
    // without reading the bucket, and a capped tick's `remaining` is visible
    // rather than hidden behind a full-looking `offboarded` count.
    return ctx.step.run('drain-due-offboardings', () => services.codeGraphOffboardSweep.sweep());
  },
);
