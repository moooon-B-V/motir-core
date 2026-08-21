import { defineJob } from '../defineJob';
import { runIndexFleetSteps } from '../indexFleetSteps';
import type { CodeGraphRefreshData } from '../types';

// Code-graph REFRESH job (Story 7.10 · MOTIR-893, the completing feed slice;
// moved onto the INDEX FLEET by MOTIR-2057) — a default-branch PUSH to a
// connected repo rebuilds that repo's graph for every project of its workspace.
// Enqueued best-effort by the webhook's `push` handler
// (`enqueueCodeGraphRefresh`, GitHub and GitLab alike) AFTER the push resolves
// to a stored repo, so the webhook returns 2xx fast and the re-index never runs
// inline in the delivery.
//
// ⚠️ IT RUNS ON THE FLEET, LIKE THE FIRST INDEX — the SAME step shape,
// `runIndexFleetSteps`, not a copy of it. THE BYTES ARE GONE FROM THIS PROCESS:
// dispatch resolves a pre-signed tarball URL and boots ONE CONTAINER per
// (repo × project) which fetches and builds the graph itself
// (`docs/decisions/code-graph-index-fleet.md` §2, §11).
//
// WHY IT MOVED (MOTIR-2057). MOTIR-1981 moved `system.code-graph-index` onto the
// fleet and left this job — architecturally the same work — on the
// serverless→HTTP path it was retiring: fetch the whole tarball into the Vercel
// function, POST the bytes to motir-ai, all under a 180 s client deadline (the
// upload client that carried it is itself deleted — MOTIR-2138). `motir-core`'s own whole-tree
// parse does not fit in 180 s, so its refresh failed DETERMINISTICALLY, and its
// five idempotent retries then queued against motir-ai's single 1-permit parse
// gate and starved every other repo's refresh — a ~68% failure rate for three
// straight days (Aug 2 7/18, Aug 3 7/16, Aug 4 8/17), which is why the symptom
// read as "intermittent motir-ai unavailability" rather than as one repo's
// deterministic timeout. On the container path no wall clock bounds the parse,
// because a STEP — never a run — is the unit the platform's timeout applies to
// (`docs/jobs.md` rule 1).
//
// ⚠️ A REFRESH HAS ALWAYS BEEN A FULL REBUILD; the fleet does not change that,
// and the claim that it was incremental was in THIS comment. motir-ai's
// incremental entry is `GraphIndexPublisher.refresh` (an engine diff, optionally
// over `changedPaths`) and NO caller has ever reached it: the bytes route this
// job used to POST to (`POST /v1/code-graph/index`) runs `receiveAndIndex` →
// `indexAndPublish` → `store.indexRepo`, a whole-tree build — exactly what the
// container does. So moving to the fleet loses no incremental semantics; it
// moves the same whole-tree parse off a 180 s budget onto a container with a
// 30-minute one. What it DOES change is where the cost lands: a metered fleet
// container per (repo × project) per debounced push, admitted by
// `codeGraphIndexAdmissionService`, instead of a queue behind one parse permit.
//
// DEBOUNCED per repo, and THAT is now the whole difference between this job and
// `system.code-graph-index`: rapid pushes to the same repo coalesce — Inngest
// holds the run until `period` passes with no further same-key event, then runs
// ONCE with the latest event. The run indexes the repo AT ITS DEFAULT BRANCH
// (not a pinned SHA), so the one coalesced run builds the newest head — exactly
// the semantics a debounce wants. The initial index must run promptly on install
// and so must never sit out a debounce window, which is why the two stay separate
// events rather than becoming one job with a flag.
//
// ⚠️ THE COALESCING IS MEASURED, THE `timeout` CAP IS NOT WHAT THIS COMMENT USED
// TO CLAIM (MOTIR-2994). Coalescing was asserted here only at the config level —
// which passes whatever the executor does — until it was driven against the real
// scheduler: a same-key burst does produce exactly ONE run carrying the latest
// event, and distinct repos stay independent, so the fleet cost model in
// `docs/decisions/code-graph-index-fleet.md` §7.3/§7.4 holds. But this comment
// also said `timeout` "caps the total deferral so a steady push stream still
// refreshes at least every 15m", and on the dev server that is FALSE for a stream
// faster than ~1 event/second — the cap never fires and the run lands only once
// the stream stops. **This job is not exposed**: its producer is default-branch
// pushes to one repo, which do not arrive at that rate. The debounce is KEPT
// unchanged and the limit recorded; see `docs/jobs.md` § Debounce for the table.
//
// ⚠️ AND THE KEY BELOW MUST KEEP NAMING ONLY REQUIRED FIELDS. A `key` expression
// that does not resolve merges every such event into ONE debounce bucket instead
// of skipping the debounce, so making any of `installationId` / `repoOwner` /
// `repoName` optional on `CodeGraphRefreshData` would silently coalesce unrelated
// repos. `tests/jobs/debounce-burst.test.ts` pins that.
//
// SYSTEM-scoped (enqueued via `inngest.send`, not `sendEvent`) and
// `retryPolicy: 'idempotent'` for the reason the index job carries it: a
// re-dispatched container rebuilds the same graph over the same commit-derived
// key, so a transient blip is worth Inngest's full 5-attempt budget — and every
// phase sits inside a memoized step, so a retry RESUMES at the project that
// failed instead of re-booting the containers that already succeeded.
//
// ⚠️ THERE IS DELIBERATELY NO `concurrency` HERE ANY MORE (MOTIR-2057), and DO
// NOT ADD ONE BACK. It carried `concurrency: 2` for a scale-to-zero motir-ai
// whose cold start each parallel run paid — the same number, and the same
// reason, MOTIR-1990 removed from the index job. All three of that job's
// arguments now apply here verbatim, because this one supervises containers too:
//
//   1. IT WOULD MAKE THE CONFIGURED CAP A LIE. A stepped supervision loop stays
//      RESIDENT for the CONTAINER'S WHOLE LIFE, where the old shape ran for one
//      fetch-and-upload. `2` beside a configured cap of six would mean two,
//      always, whatever an operator set.
//
//      ⚠️ CORRECTED (MOTIR-3245) — this used to say the loop holds its INNGEST
//      CONCURRENCY SLOT for the container's whole life, and MOTIR-3245 was filed
//      on that sentence. It is false. Inngest's concurrency documentation is
//      explicit: *"A function run that is sleeping, waiting for an event, or
//      paused between steps does not count against your concurrency limit. Only
//      steps that are actively executing code count toward the limit"*, and
//      *"calling `step.sleep`, `step.sleepUntil`, `step.waitForEvent`, or
//      `step.invoke` does not count towards capacity limits."*
//
//      This loop waits with `ctx.step.sleep` (`indexFleetSteps.ts`,
//      `index-wait:<pid>:<n>`), so between polls it holds NOTHING. A
//      `concurrency: N` here would bound N concurrent POLLS, not N live
//      containers — so the conclusion below is unchanged and its reason is now
//      the true one rather than a plausible one.
//   2. AN UNKEYED LIMIT IS THE STARVATION IT WAS MEANT TO PREVENT — and THIS job
//      is where that was measured: one repo's retries ahead of every other
//      repo's refresh is the production failure MOTIR-2057 fixed. A per-tenant
//      limit here would need a KEYED concurrency. `defineJob` CAN express one
//      since MOTIR-1982 — but reason 1 rules it out here anyway: a cap on a
//      container supervisor caps SUPERVISORS, not containers, keyed or not.
//   3. ITS ORIGINAL REASON IS GONE. The bytes moved to the containers; what
//      remains in-process is one short credential mint.
//
// The cap lives where the containers are — `codeGraphIndexAdmissionService`, a
// global bound read from `MOTIR_INDEX_MAX_IN_FLIGHT` plus a per-workspace bound
// of `ceil(global / 2)` — which is also the only place that can see the OTHER
// workloads sharing the invoice (MOTIR-1997).
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
    return runIndexFleetSteps(ctx, services, {
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
