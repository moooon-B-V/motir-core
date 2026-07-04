import { defineJob } from '../defineJob';
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
// converges), one `step.run` (the tarball bytes can't cross a step boundary),
// all logic delegated to the service (the 4-layer handler-is-a-caller rule).
export const codeGraphRefresh = defineJob(
  {
    id: 'system.code-graph-refresh',
    retryPolicy: 'idempotent',
    debounce: {
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    },
  },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphRefreshData;
    return ctx.step.run('refresh-repo', () =>
      services.codeGraph.indexRepoIntoWorkspaceProjects({
        installationId: data.installationId,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        defaultBranch: data.defaultBranch,
      }),
    );
  },
);
