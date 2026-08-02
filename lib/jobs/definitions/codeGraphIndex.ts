import { defineJob } from '../defineJob';
import { runCodeGraphIndexSteps } from '../codeGraphSteps';
import type { CodeGraphIndexData } from '../types';

// Code-graph INDEX job (Story 7.5 · MOTIR-1500, the motir-core producer half) —
// fetch a newly-added GitHub repo's source with the INSTALLATION token and hand
// the raw gzipped-tarball BYTES to motir-ai to build a code graph. Enqueued
// best-effort AFTER the installation's repos persist (`enqueueCodeGraphIndex`),
// so the webhook returns fast and a failed GitHub/motir-ai call can never roll
// back or block the grant mirror (the side-effects-outside-tx rule).
//
// SYSTEM-scoped (`system.*`): the work spans an installation's workspace + its
// projects, resolved under `withSystemContext` inside the service — like every
// `system.*` job, it is enqueued via `inngest.send` directly (NOT `sendEvent`).
//
// `retryPolicy: 'idempotent'`: re-indexing the same repo is convergent by
// construction (motir-ai rebuilds the project's graph from the same bytes), so a
// transient GitHub/motir-ai blip is worth Inngest's full 5-attempt budget. All
// the work is delegated to the service (the 4-layer "handler is a service
// caller" rule — the `billingSeatSync` precedent); the durable step SHAPE it
// runs in is `runCodeGraphIndexSteps`, shared with the refresh job — read the
// MOTIR-1974 note there for WHY it is a step per project.
//
// `concurrency: 2` caps how many repos index at once. The measured aggravator on
// 2026-08-02 was five runs firing simultaneously at a scale-to-zero motir-ai
// machine whose cold start alone took 23.3s — each paying it, none benefiting
// from the machine another had already woken. Serializing to two lets the first
// wake it for the rest. It bounds RUNS, not steps, so one repo's per-project
// steps still proceed one after another inside its own run.
//
// NOTE: this is motir-core's OWN internal job substrate. It is unrelated to
// motir-ai's frozen JOB_KINDS contract — motir-ai exposes a plain bytes route
// (`POST /v1/code-graph/index`), NOT a JobKind, so `lib/ai/types.ts` is untouched.
export const codeGraphIndex = defineJob(
  { id: 'system.code-graph-index', retryPolicy: 'idempotent', concurrency: 2 },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphIndexData;
    return runCodeGraphIndexSteps(ctx, services, {
      installationId: data.installationId,
      // Carried on the payload since MOTIR-1500 and now LOAD-BEARING
      // (MOTIR-1931): it is the repo's own tenant, stamped at enqueue.
      workspaceId: data.workspaceId,
      repoOwner: data.repoOwner,
      repoName: data.repoName,
      defaultBranch: data.defaultBranch,
    });
  },
);
