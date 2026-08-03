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
// `concurrency: 2` caps how many repos index at once. The measured aggravator on
// 2026-08-02 was five runs firing simultaneously at a scale-to-zero motir-ai
// machine whose cold start alone took 23.3s — each paying it, none benefiting
// from the machine another had already woken. Serializing to two lets the first
// wake it for the rest. It bounds RUNS, not steps, so one repo's per-project
// steps still proceed one after another inside its own run.
//
// ⚠️ AND `2` NOW MEANS SOMETHING MATERIALLY DIFFERENT — flagged forward, not
// changed here. A stepped supervision loop holds its Inngest concurrency slot
// for the CONTAINER'S WHOLE LIFE, where the old shape held it for one
// fetch-and-upload. MOTIR-1990 owns every concurrency number in this fleet
// (`docs/decisions/code-graph-index-fleet.md` §7) and is the card that must
// price that in; this one deliberately leaves the value untouched.
//
// NOTE: this is motir-core's OWN internal job substrate. It is unrelated to
// motir-ai's frozen JOB_KINDS contract — motir-ai exposes a plain bytes route
// (`POST /v1/code-graph/index`), NOT a JobKind, so `lib/ai/types.ts` is untouched.
export const codeGraphIndex = defineJob(
  { id: 'system.code-graph-index', retryPolicy: 'idempotent', concurrency: 2 },
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
