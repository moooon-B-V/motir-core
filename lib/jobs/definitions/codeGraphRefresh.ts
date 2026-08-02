import { defineJob } from '../defineJob';
import { runCodeGraphIndexSteps } from '../codeGraphSteps';
import type { CodeGraphRefreshData } from '../types';

// Code-graph REFRESH job (Story 7.10 · MOTIR-893, the completing feed slice) —
// a default-branch PUSH to a connected repo re-fetches its source with the
// INSTALLATION token and hands the bytes to motir-ai, which refreshes that
// tenant's existing graph incrementally. Enqueued best-effort by the webhook's
// `push` handler (`enqueueCodeGraphRefresh`) AFTER the push resolves to a
// stored repo, so the webhook returns 2xx fast and the re-index never runs
// inline in the delivery.
//
// DEBOUNCED per repo (the scale posture): rapid pushes to the same repo
// coalesce — Inngest holds the run until `period` passes with no further
// same-key event, then runs ONCE with the latest event; `timeout` caps the
// total deferral so a steady push stream still refreshes at least every 15m.
// The handler fetches the repo AT ITS DEFAULT BRANCH (not a pinned SHA), so
// the one coalesced run indexes the newest head — exactly the semantics a
// debounce wants. This is why refresh is a SEPARATE event from
// `system.code-graph-index`: the initial index must run promptly on install,
// never sit out a debounce window.
//
// Same shape as the index job otherwise: SYSTEM-scoped (enqueued via
// `inngest.send`, not `sendEvent`), `retryPolicy: 'idempotent'` (re-indexing
// converges), all logic delegated to the service (the 4-layer
// handler-is-a-caller rule), and the SAME durable step shape —
// `runCodeGraphIndexSteps`, a step per project (MOTIR-1974; the single-step
// version could not finish inside one platform invocation, and this job would
// have died the same way the index job did once pushes started reaching it).
// `concurrency: 2` for the same reason the index job carries it: motir-ai is
// scale-to-zero, and parallel runs each pay the cold start instead of sharing
// one woken machine.
export const codeGraphRefresh = defineJob(
  {
    id: 'system.code-graph-refresh',
    retryPolicy: 'idempotent',
    concurrency: 2,
    debounce: {
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    },
  },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphRefreshData;
    return runCodeGraphIndexSteps(ctx, services, {
      installationId: data.installationId,
      // The repo's own tenant, stamped at enqueue from `repo.workspaceId`
      // (MOTIR-1931) — never re-derived from the shared installation.
      workspaceId: data.workspaceId,
      repoOwner: data.repoOwner,
      repoName: data.repoName,
      defaultBranch: data.defaultBranch,
    });
  },
);
