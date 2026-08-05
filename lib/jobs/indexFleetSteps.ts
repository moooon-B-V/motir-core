import { indexFleetConfig } from '@/lib/orchestrator';
import {
  INDEX_ADMISSION_BUDGETS,
  INDEX_FLEET_TIME_BUDGETS,
  INITIAL_INDEX_POLL_STATE,
  indexAdmissionWaitMs,
  indexPollWaitMs,
  type IndexDispatchOutcome,
  type IndexPollResult,
  type IndexSession,
} from '@/lib/services/codeGraphIndexDispatchService';
import type { IndexAdmissionVerdict } from '@/lib/services/codeGraphIndexAdmissionService';
import type { JobContext } from './defineJob';
import type { JobServices } from './services';
import type {
  IndexRepoInput,
  IndexRepoResult,
  IndexTarget,
} from '@/lib/services/codeGraphIndexService';

// THE DURABLE STEP SHAPE for `system.code-graph-index` (Story MOTIR-1981 ·
// MOTIR-2027) — the last card of the dispatch chain. The job stops fetching
// bytes and starts driving `codeGraphIndexDispatchService` as durable steps, so
// NO REPO TARBALL EVER ENTERS A VERCEL FUNCTION AGAIN.
//
// `docs/decisions/code-graph-index-fleet.md` §2 (every failure of the old path
// descends from one shape) and §6 (the ledger contract that forces one row per
// repo).
//
//   step  resolve-target                 DB reads only — UNCHANGED
//     ↓   (the three no-op verdicts return here, exactly as before)
//   step  assert-fleet-configured        the gate, BEFORE anything is spent
//   for each projectId of target.projectIds:
//   step    index-admit:<pid>:<n>        the CAP — one locked decision (bounded)
//   step    sleep index-admit-wait:<n>   ctx.step.sleep — the QUEUE, if deferred
//     ↓     …until admitted
//   step    index-boot:<projectId>       mint + resolve + provision   (bounded)
//   step    sleep index-wait:<pid>:<n>   ctx.step.sleep — costs no invocation
//   step    index-poll:<pid>:<n>         ONE describe                 (bounded)
//     ↓     …until a `done` verdict
//   step    index-settle:<projectId>     teardown + the typed outcome (bounded)
//
// ⚠️ WHY STEPPED, AND NOT A LOOP INSIDE ONE STEP. An index run is minutes;
// `app/api/inngest/route.ts` pins `maxDuration = 300`. This is the MOTIR-2007
// shape applied to a second workload — there, an hour-long supervision loop
// inside one invocation meant every CI job over ~5 minutes had its supervisor
// killed: the intent stuck, the container's cost unrecorded, and the run
// dead-lettered while the job had actually succeeded. A STEP, NOT A RUN, IS THE
// UNIT THE PLATFORM'S TIMEOUT APPLIES TO (`docs/jobs.md` rule 1), so the WAITING
// is `ctx.step.sleep` — which holds no invocation at all — and every `step.run`
// does one small thing. `codeGraphIndexDispatchService` is built for exactly
// this: its three operations are individually bounded and its poll NEVER THROWS,
// because in a stepped world teardown cannot be reached from a `catch`
// (PRODECT_FINDINGS #39).
//
// ⚠️ STEP IDS ARE KEYED BY `projectId`, NEVER BY LOOP POSITION. The id is what
// Inngest memoizes against, so it must identify the SAME unit of work on every
// replay; a positional index would silently re-point at another project if the
// workspace's project list changed between attempts. The poll and its preceding
// sleep also carry the ITERATION, so a replay reproduces the same sequence.
//
// ⚠️ THE LEDGER CONTRACT DOES NOT MOVE (§6). Whatever the fan-out does
// internally — one container per (repo × project), MOTIR-2026 — the JOB still
// produces ONE `job_run` per repo, `succeeded`, with ONE `output.repoRef`. That
// is the shape `jobRunRepository.listSucceededCodeGraphIndexRepoRefs` reads to
// build the indexed set, and the shape `MigrateIndexRepoDto` /
// `MigrateIndexStatusDto.allIndexed` gates the onboarding wizard's per-repo rows
// and its Next button on. So {@link IndexRepoResult} keeps its current fields,
// and a run that did not index every project THROWS rather than returning a
// diminished success — see {@link IndexDispatchFailedError}.
//
// ⚠️ THE ADMISSION CAP IS A LOOP OF STEPS, NOT A WAIT INSIDE ONE (MOTIR-1990).
// Each `index-admit:<pid>:<n>` is ONE locked decision, in milliseconds; the
// QUEUEING between attempts is `ctx.step.sleep`, which holds no invocation at
// all. The attempt number is in the step id for the same reason the poll's is:
// the id is what Inngest memoizes against, so a single `index-admit:<pid>` would
// pin the FIRST answer forever and a deferral would become a permanent one — an
// index that waits could never be admitted. Over the cap means WAIT; nothing is
// dropped, and exhausting the whole budget FAILS the run rather than skipping the
// repo (§6: a `succeeded` row is a permanent claim that the repo is indexed).
//
// ⚠️ `system.code-graph-refresh` DRIVES THIS SAME SHAPE (MOTIR-2057). MOTIR-2027
// left it on the in-process `runCodeGraphIndexSteps` (§11: "Still building
// in-process, unchanged"), and production then showed why an abandoned path with
// a live caller is not a neutral state: a push refresh fetched the whole tarball
// into the function under a 180 s client deadline, `motir-core` never fit, and
// its retries starved every other repo's refresh at a ~68% failure rate. Both
// jobs are now one code path, differing ONLY in their event and in the refresh
// job's per-repo debounce — that difference is config on the job, not a mode
// flag in here, which is why they can share this function without one.
//
// So EVERY caller of this file supervises containers, and the notes below about
// the ledger, the admission cap and step-id keying hold for a refresh run
// exactly as for a first index. `codeGraphSteps.ts` is gone: nothing calls the
// in-process shape, and leaving it importable is how a third caller would have
// re-adopted the same defect.

/**
 * A dispatched index container did not index its project.
 *
 * ⚠️ IT THROWS RATHER THAN DEGRADING THE RESULT, and that is the ledger contract
 * being enforced, not a style choice. `defineJob` writes `output` only on the
 * success path, so a throw is what keeps a `succeeded` row carrying an
 * `output.repoRef` out of the ledger for a repo nothing indexed — a row that
 * would tell the enqueue gate and the onboarding wizard that the repo has a code
 * graph, forever, to every reader (§6).
 *
 * The message carries the dispatch service's NAMED exit class, never a bare
 * number: "the parser died on this tree" (`graph_unbuildable`), "motir-ai
 * refused the pointer" (`pointer_unrecorded`) and "the kernel OOM-killed it"
 * (`out_of_memory`) are three different on-call responses, and the operator
 * reads them off the failed run.
 */
export class IndexDispatchFailedError extends Error {
  readonly code = 'INDEX_DISPATCH_FAILED' as const;
  constructor(
    readonly repoRef: string,
    readonly projectId: string,
    /** The dispatch service's outcome discriminator, or its named exit class. */
    readonly exitClass: string,
    detail: string,
  ) {
    super(`Indexing ${repoRef} into project ${projectId} failed (${exitClass}): ${detail}`);
    this.name = 'IndexDispatchFailedError';
  }
}

/**
 * Drive ONE repo's container-based index as durable steps.
 *
 * Returns the same {@link IndexRepoResult} the in-process shape returned — the
 * ledger's contract — or throws {@link IndexDispatchFailedError} for a container
 * that did not reach exit 0.
 */
export async function runIndexFleetSteps(
  ctx: JobContext,
  services: JobServices,
  input: IndexRepoInput,
): Promise<IndexRepoResult> {
  const target = (await ctx.step.run('resolve-target', () =>
    services.codeGraph.resolveIndexTarget(input),
  )) as IndexTarget;
  // ⚠️ UNCHANGED, AND BEFORE THE GATE. A vanished tenant / project-less
  // workspace is a clean no-op whose reason IS the run's ledger output — the
  // shipped contract that this job never throws on a tenant that went away. Its
  // three verdicts must keep reaching the ledger on a deployment that could not
  // have indexed anything anyway, so the config gate cannot come first.
  if (!target.indexed) return target;

  // ⚠️ THE CONFIG GATE, AND IT FAILS LOUDLY. `indexFleetConfig()` names EVERY
  // missing variable at once and throws. A path that quietly returned "nothing
  // to do" when unconfigured would still let this job record a `succeeded`
  // `job_run` carrying an `output.repoRef` for a repo nothing ever indexed —
  // indistinguishable from success everywhere downstream. Its own step, so the
  // deployment fault is one named checkpoint rather than N boot failures, and so
  // it fires BEFORE the first container is billed.
  await ctx.step.run('assert-fleet-configured', () => {
    indexFleetConfig();
    return { configured: true };
  });

  for (const projectId of target.projectIds) {
    const dispatchInput = {
      installationId: input.installationId,
      providerId: target.providerId,
      organizationId: target.organizationId,
      workspaceId: input.workspaceId,
      projectId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      repoRef: target.repoRef,
      defaultBranch: input.defaultBranch,
      // The dispatching run, carried into the run-scoped motir-ai credential
      // for attribution. Read once at the top of the handler and consumed
      // INSIDE a memoized step, so a replay pass (which Inngest re-invokes
      // with the same run) never re-mints against a different identity.
      runId: ctx.runId,
      // ⚠️ AND THE DISPATCH'S IDENTITY, WHICH OWNS THE ADMISSION SLOT
      // (MOTIR-2160) — the triggering event's id, exactly the expression
      // `defineJob` derives its ledger `eventId` from, so a deferred run and the
      // run it is waiting on are findable by the same key.
      //
      // NOT `ctx.runId`, and the difference is the point: this value is compared
      // ACROSS passes (taken in `index-admit`, checked again in `index-settle`
      // many passes later), whereas `runId` is re-read at the top of the handler
      // on every one of them. The event's id is a property of the trigger, so it
      // survives the round trip the ownership check depends on. The `??` mirrors
      // `defineJob`'s own fallback for a trigger that carries no id.
      dispatchId: ctx.event.id ?? ctx.runId,
    };

    // ⚠️ THE CAP, BEFORE ANY CONTAINER IS BOOTED. Nothing below can run without
    // the ticket this produces — `bootIndexContainer` requires it — so the
    // global and per-workspace bounds are structural here, not conventional.
    const admission = await admitWithBackoff(ctx, services, dispatchInput, projectId);
    if (admission.outcome === 'deferred') {
      throw dispatchFailure(target.repoRef, projectId, {
        outcome: 'admission_deferred',
        reason: admission.reason,
        detail: admission.detail,
      });
    }

    const booted = await ctx.step.run(`index-boot:${projectId}`, () =>
      services.codeGraphIndexDispatch.bootIndexContainer(dispatchInput, admission.admission),
    );
    // Nothing was provisioned — no container to supervise or tear down. The
    // outcome is terminal, and it is a FAILURE: no project was indexed, so the
    // run must not go on to claim the repo.
    if (booted.phase === 'terminal')
      throw dispatchFailure(target.repoRef, projectId, booted.outcome);

    const session: IndexSession = booted.session;
    let state = INITIAL_INDEX_POLL_STATE;
    let verdict: Extract<IndexPollResult, { done: true }> | null = null;

    for (
      let iteration = 1;
      iteration <= INDEX_FLEET_TIME_BUDGETS.maxPollIterations;
      iteration += 1
    ) {
      // Free waiting: Inngest schedules the resume, so the interval costs a
      // checkpoint rather than an invocation. `indexPollWaitMs` is PURE — a
      // function of the iteration, never of the clock — because a replay pass
      // re-derives every sleep in the loop, and a wall-clock input would make
      // two passes of the same run disagree about how long to wait.
      await ctx.step.sleep(`index-wait:${projectId}:${iteration}`, indexPollWaitMs(iteration));
      // ONE provider read, then return. This is the step the card exists to
      // bound; `pollIndexContainer` never throws, because a throw here would end
      // the run WITHOUT teardown.
      const polled: IndexPollResult = await ctx.step.run(
        `index-poll:${projectId}:${iteration}`,
        () => services.codeGraphIndexDispatch.pollIndexContainer(session, state),
      );
      if (polled.done) {
        verdict = polled;
        break;
      }
      state = polled;
    }

    // ⚠️ TEARDOWN IS REACHED ON EVERY PATH OUT OF THE LOOP — the stepped form of
    // the `finally` a synchronous supervisor would have relied on. The loop can
    // only exit with a `done` verdict or by exhausting the static iteration
    // ceiling, and both arrive here.
    const outcome: IndexDispatchOutcome = await ctx.step.run(`index-settle:${projectId}`, () =>
      services.codeGraphIndexDispatch.settleIndexContainer(
        session,
        verdict ?? {
          done: true,
          reason: 'job_timed_out',
          startedAt: state.startedAt,
          exitCode: null,
          failureDetail: `supervision hit the ${INDEX_FLEET_TIME_BUDGETS.maxPollIterations}-poll ceiling`,
        },
      ),
    );

    // ⚠️ ONLY EXIT 0 INDEXED. `verdict.indexed` is true for that and nothing
    // else — an unobserved exit, a torn-down-but-unclassified run and a failed
    // teardown all leave it false — so this is the single place the run decides
    // whether the repo may be claimed.
    if (outcome.outcome !== 'settled' || !outcome.verdict.indexed) {
      throw dispatchFailure(target.repoRef, projectId, outcome);
    }
  }

  // The ledger's row: ONE per repo, with ONE `output.repoRef`, reached only when
  // EVERY project's container exited 0.
  return {
    indexed: true,
    repoRef: target.repoRef,
    projectsIndexed: target.projectIds.length,
  };
}

/**
 * Ask for admission, sleeping between attempts, until it is granted or the
 * waiting budget is exhausted — the durable form of "over the cap means WAIT".
 *
 * Every attempt is its OWN step id. That is the load-bearing detail: Inngest
 * memoizes by id, so one shared id would freeze the first `deferred` answer for
 * the life of the run and the queue would never move.
 *
 * The sleep is `ctx.step.sleep`, so a container waiting an hour for capacity
 * costs zero invocations and cannot be killed by `maxDuration` — the same reason
 * supervision waits that way (`docs/jobs.md` rule 1).
 */
async function admitWithBackoff(
  ctx: JobContext,
  services: JobServices,
  dispatchInput: Parameters<JobServices['codeGraphIndexDispatch']['admitIndexContainer']>[0],
  projectId: string,
): Promise<IndexAdmissionVerdict> {
  let verdict: IndexAdmissionVerdict = {
    outcome: 'deferred',
    reason: 'gate_unavailable',
    detail: 'admission was never attempted',
  };
  for (let attempt = 1; attempt <= INDEX_ADMISSION_BUDGETS.maxAttempts; attempt += 1) {
    verdict = (await ctx.step.run(`index-admit:${projectId}:${attempt}`, () =>
      services.codeGraphIndexDispatch.admitIndexContainer(dispatchInput),
    )) as IndexAdmissionVerdict;
    if (verdict.outcome !== 'deferred') return verdict;
    if (attempt < INDEX_ADMISSION_BUDGETS.maxAttempts) {
      await ctx.step.sleep(
        `index-admit-wait:${projectId}:${attempt}`,
        indexAdmissionWaitMs(attempt),
      );
    }
  }
  return {
    ...verdict,
    detail: `index admission was refused for ${INDEX_ADMISSION_BUDGETS.maxAttempts} attempts (${verdict.reason}): ${verdict.detail}`,
  };
}

/** The named failure for a dispatch outcome that did not index. */
function dispatchFailure(
  repoRef: string,
  projectId: string,
  outcome: IndexDispatchOutcome,
): IndexDispatchFailedError {
  if (outcome.outcome === 'settled') {
    return new IndexDispatchFailedError(
      repoRef,
      projectId,
      outcome.verdict.exitClass,
      outcome.failureDetail ?? outcome.verdict.detail,
    );
  }
  return new IndexDispatchFailedError(repoRef, projectId, outcome.outcome, outcome.detail);
}
