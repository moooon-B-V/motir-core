import { defineJob } from '../defineJob';
import { runIndexFleetSteps } from '../indexFleetSteps';
import type { CodeGraphIndexData } from '../types';

// Code-graph INDEX job (Story 7.5 · MOTIR-1500, re-shaped by Story MOTIR-1981 ·
// MOTIR-2027) — index a newly-added repo's source into every project of its
// workspace. Enqueued best-effort AFTER the installation's repos persist
// (`enqueueCodeGraphIndex`), so the webhook returns fast and a failed
// GitHub/motir-ai call can never roll back or block the grant mirror (the
// side-effects-outside-tx rule).
//
// ⚠️ THE BYTES ARE GONE FROM THIS PROCESS. It used to fetch the repo's tarball
// into the function's heap and upload it to motir-ai once per project; since
// MOTIR-2027 it resolves a pre-signed URL and dispatches ONE CONTAINER per
// (repo × project) that fetches and builds the graph itself
// (`docs/decisions/code-graph-index-fleet.md` §2). The step shape that drives
// it is `runIndexFleetSteps` — read the note there for why supervision is a
// sequence of bounded steps and not a loop.
//
// SYSTEM-scoped (`system.*`): the work spans an installation's workspace + its
// projects, resolved under `withSystemContext` inside the service — like every
// `system.*` job, it is enqueued via `inngest.send` directly (NOT `sendEvent`).
//
// `retryPolicy: 'idempotent'`: re-indexing the same repo is convergent by
// construction (a re-dispatched container rebuilds the same graph and overwrites
// the same commit-derived key), so a transient blip is worth Inngest's full
// 5-attempt budget — and because every phase now sits inside a memoized step, a
// retry RESUMES at the project that failed instead of re-booting the containers
// that already succeeded. All the work is delegated to services (the 4-layer
// "handler is a service caller" rule — the `billingSeatSync` precedent).
//
// ⚠️ THERE IS DELIBERATELY NO `concurrency` HERE ANY MORE (MOTIR-1990,
// `docs/decisions/code-graph-index-fleet.md` §7). The cap lives in the
// ORCHESTRATOR's admission control — `codeGraphIndexAdmissionService`, a global
// bound read from `MOTIR_INDEX_MAX_IN_FLIGHT` plus a per-workspace bound of
// `ceil(global / 2)` — and DO NOT ADD ONE BACK. Three reasons, in order of how
// badly each bites:
//
//   1. IT WOULD MAKE THE CONFIGURED CAP A LIE. A stepped supervision loop holds
//      its Inngest concurrency slot for the CONTAINER'S WHOLE LIFE, where the old
//      shape held it for one fetch-and-upload. `concurrency: 2` beside a
//      configured cap of six would mean two, always, whatever an operator set.
//   2. AN UNKEYED LIMIT IS THE STARVATION IT WAS MEANT TO PREVENT. It is global
//      and tenant-blind, so one workspace's five repos occupy the lane while
//      another workspace's first index queues behind all of it — the measured
//      behaviour §7 records. A per-tenant limit HERE would need a KEYED
//      concurrency, which `defineJob` discards entirely (MOTIR-1982).
//   3. ITS ORIGINAL REASON IS GONE. `2` existed for a scale-to-zero motir-ai
//      whose cold start took 23.3s on 2026-08-02, when five runs each fetched a
//      tarball and uploaded it from this process. The bytes moved to the
//      containers (§2); what remains in-process is one short credential mint.
//      The admission cap bounds the herd far more precisely than a run count did.
//
// The cap is now enforced where the containers actually are, which is also the
// only place that can see the OTHER workloads sharing the invoice (MOTIR-1997).
//
// NOTE: this is motir-core's OWN internal job substrate. It is unrelated to
// motir-ai's frozen JOB_KINDS contract — motir-ai exposes a plain bytes route
// (`POST /v1/code-graph/index`), NOT a JobKind, so `lib/ai/types.ts` is untouched.
export const codeGraphIndex = defineJob(
  { id: 'system.code-graph-index', retryPolicy: 'idempotent' },
  async (ctx, services) => {
    const data = ctx.event.data as CodeGraphIndexData;
    return runIndexFleetSteps(ctx, services, {
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
