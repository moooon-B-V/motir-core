import { defineJob } from '../defineJob';
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
// transient GitHub/motir-ai blip is worth Inngest's full 5-attempt budget. The
// fetch + per-project index run in ONE `step.run` (the tarball ArrayBuffer can't
// cross a step boundary), and the handler delegates all logic to the service (the
// 4-layer "handler is a service caller" rule — the `billingSeatSync` precedent).
//
// NOTE: this is motir-core's OWN internal job substrate. It is unrelated to
// motir-ai's frozen JOB_KINDS contract — motir-ai exposes a plain bytes route
// (`POST /v1/code-graph/index`), NOT a JobKind, so `lib/ai/types.ts` is untouched.
export const codeGraphIndex = defineJob(
  { id: 'system.code-graph-index', retryPolicy: 'idempotent' },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphIndexData;
    return ctx.step.run('index-repo', () =>
      services.codeGraph.indexRepoIntoWorkspaceProjects({
        installationId: data.installationId,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        defaultBranch: data.defaultBranch,
      }),
    );
  },
);
