import { indexFleetConfig } from '@/lib/orchestrator';
import type {
  IndexDispatchOutcome,
  SupervisionSteps,
} from '@/lib/services/codeGraphIndexDispatchService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { withSystemContext } from '@/lib/workspaces/context';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import type { JobContext } from './defineJob';
import type { JobServices } from './services';
import type {
  IndexCoreTimings,
  IndexRepoInput,
  IndexRepoResult,
  IndexTarget,
} from '@/lib/services/codeGraphIndexService';

// THE INDEX FLEET'S JOB-SIDE DRIVER for `system.code-graph-index` and
// `system.code-graph-refresh` (Story MOTIR-1981 · MOTIR-2027 · MOTIR-2057), as
// COLLAPSED by MOTIR-3484.
//
// `docs/decisions/code-graph-index-fleet.md` §2 (every failure of the old path
// descends from one shape) and §6 (the ledger contract that forces one row per
// repo).
//
//   step  resolve-target                 DB reads only — UNCHANGED
//     ↓   (the three no-op verdicts return here, exactly as before)
//         assert-fleet-configured        the gate, BEFORE anything is spent
//   for each projectId of target.projectIds:
//           codeGraphIndexDispatchService.advanceIndexContainer(runId, …, { steps })
//             step  index-admit:<pid>    the CAP — the whole backoff, memoized once
//             step  index-boot:<pid>     mint + resolve + provision
//                   …then ONE poll, and a DEFER of this very run (MOTIR-3828)
//             step  index-settle:<pid>   teardown + the typed outcome
//   step  cancel-offboarding
//
// ⚠️ WHAT THIS FILE USED TO SAY, AND WHY IT NO LONGER SAYS IT (MOTIR-3484).
// Four blocks here argued the shape from Vercel. The longest opened *"⚠️ WHY
// STEPPED, AND NOT A LOOP INSIDE ONE STEP. An index run is minutes;
// `app/api/inngest/route.ts` pins `maxDuration = 300` … A STEP, NOT A RUN, IS THE
// UNIT THE PLATFORM'S TIMEOUT APPLIES TO (`docs/jobs.md` rule 1), so the WAITING
// is `ctx.step.sleep`"*. Every word of that was TRUE, and every word of it was
// about a platform we left: `Dockerfile` ends `CMD ["node", "server.js"]` and
// motir-core has run as a long-lived Fly process since MOTIR-2384. **A supervisor
// can be an ordinary `async` function with a `while` loop and an `await` again**,
// so it is one — and it lives in `codeGraphIndexDispatchService`, which already
// carried that composition as its "not the production path" twin.
//
// The blocks are CORRECTED rather than deleted, here and at each of their homes,
// because a future reader has to be able to see that the world changed and not
// merely that the code did. What went with them:
//
//   • `admitWithBackoff` — sixty separately-memoized `index-admit:<pid>:<n>`
//     steps, whose per-attempt ids existed for one reason: a single
//     `index-admit:<pid>` would have frozen the first `deferred` answer forever
//     and an index that waited could never be admitted. Nothing memoizes an
//     in-process loop, so the loop is a loop again and the whole of it sits in
//     ONE step (`docs/decisions/job-queue-foundation.md` §13.3(c) says why it
//     must be a step at all rather than plain control flow).
//   • The stepped poll loop — `index-wait:<pid>:<n>` / `index-poll:<pid>:<n>`,
//     roughly 128 checkpoints per 30-minute index, each a database write.
//   • The stepped `finally` — teardown written as a step reachable from both
//     exits, because a real `finally` could not be trusted across invocations. It
//     is an ordinary `finally` again, in the service's loop.
//
// ⚠️ WHAT DID NOT GO: THE DURABILITY. `docs/decisions/job-queue-foundation.md`
// §13 decides which `ctx.step` calls a supervision loop keeps — the SIDE EFFECT,
// never the WAIT — and §13.4 tables the disposition of every call site that used
// to be here. The three that remain (`index-admit`, `index-boot`, `index-settle`)
// are the ones that claim capacity, provision a billed container, and destroy
// one. A worker restart replays them from `job_step` and the loop re-attaches to
// the same container rather than booting a second.
//
// ⚠️ STEP IDS ARE STILL KEYED BY `projectId`, NEVER BY LOOP POSITION — and the
// rule matters MORE now, not less. It used to be one caveat among many in a file
// full of ids; there are three ids left and each one carries more. The id is what
// the ledger memoizes against, so it must identify the SAME unit of work on every
// replay; a positional index would silently re-point at another project if the
// workspace's project list changed between passes. That is also why
// `resolve-target` stays a memoized step (§13.1 limb 2): its `projectIds` ARE the
// identity the three below are keyed by.
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
// ⚠️ THE ADMISSION CAP IS STILL "OVER THE CAP MEANS WAIT, NEVER DROP"
// (MOTIR-1990). Nothing about the collapse touches the cap, the budgets or the
// waiting: `codeGraphIndexAdmissionService` and `lib/ciFleet/limits.ts` are
// untouched by this card because a regression there costs money, and exhausting
// the whole waiting budget still FAILS the run rather than skipping the repo
// (§6: a `succeeded` row is a permanent claim that the repo is indexed).
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
 * number: "the parser died on this tree" (`graph_unbuildable`), "motir-ai refused
 * the pointer" (`pointer_unrecorded`) and "the kernel OOM-killed it"
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
 * Adapt a job's `ctx.step` to the seam the dispatch service composes against.
 *
 * ONE cast, at the boundary — the same shape and the same reason as
 * `lib/jobs/engine/runner.ts`'s single cast. Inngest's `step.run` types its
 * result as `Jsonify<T>` (which is what the `as IndexTarget` at the
 * `resolve-target` call site below has always been for), and the engine's shim
 * round-trips through JSON on BOTH the first execution and the replay so the two
 * cannot disagree. Every value that crosses this seam is declared
 * JSON-serializable by contract — `IndexAdmission`, `IndexSession` and
 * `IndexDispatchOutcome` all carry ISO strings rather than `Date`s, and say so.
 */
function stepSeam(ctx: JobContext): SupervisionSteps {
  return {
    run: <T>(id: string, fn: () => T | Promise<T>): Promise<T> =>
      ctx.step.run(id, fn as () => Promise<T>) as unknown as Promise<T>,
  };
}

/**
 * Drive ONE repo's container-based index.
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

  // ⚠️ THE IDENTITY THIS RUN HOLDS THINGS UNDER, ACROSS PASSES — the triggering
  // event's id, exactly the expression `defineJob` derives its ledger `eventId`
  // from, so a deferred run and the run it is waiting on are findable by the same
  // key.
  //
  // NOT `ctx.runId`, and the difference is the point: the ADMISSION SLOT is taken
  // in `index-admit` and checked again in `index-settle` many passes later,
  // whereas `ctx.runId` is re-read at the top of the handler on every one of those
  // passes. The event's id is a property of the TRIGGER, so it survives the round
  // trip the ownership check depends on. The `??` mirrors `defineJob`'s own
  // fallback for a trigger that carries no id.
  //
  // ⚠️ AND IT STILL HOLDS ON THE POSTGRES ENGINE. `buildEngineContext`
  // (`lib/jobs/engine/runner.ts`) sets `event.id` from `run.eventId` and `runId`
  // from the queue row's id, both stable for the life of the run — so this
  // expression names the same dispatch on every pass there exactly as it did on
  // Inngest (`docs/decisions/job-queue-foundation.md` §13.2).
  //
  // ⚠️ Computed ONCE here and passed down, rather than inline at the use site.
  // MOTIR-3358 added a SECOND cross-pass claim that had to hold the same value,
  // and hoisting it was what stopped the two drifting apart; that second consumer
  // is gone (MOTIR-3380) but the hoist stays, because the reason it was a bug the
  // first time — `ctx.runId` looks stable and is not — is unchanged, and a third
  // consumer would reintroduce it.
  const dispatchId = ctx.event.id ?? ctx.runId;

  // ⚠️ THE CONFIG GATE, AND IT FAILS LOUDLY. `indexFleetConfig()` names EVERY
  // missing variable at once and throws. A path that quietly returned "nothing
  // to do" when unconfigured would still let this job record a `succeeded`
  // `job_run` carrying an `output.repoRef` for a repo nothing ever indexed —
  // indistinguishable from success everywhere downstream. It fires BEFORE the
  // first container is billed, which is the whole of what it is for.
  //
  // ⚠️ IT IS NO LONGER ITS OWN STEP (MOTIR-3484 · §13.4). It used to be one, "so
  // the deployment fault is one named checkpoint rather than N boot failures" —
  // a real benefit when a checkpoint was the unit an operator read, and not worth
  // a memo row now. Under §13.1's test it is a READ of process configuration that
  // throws: run it a second time and nothing exists twice. It throws identically
  // on every pass, which is exactly what a deployment fault should do.
  indexFleetConfig();

  // ⚠️ CLAIM THE REPOSITORY, AND CAPTURE THE HEAD IT IS BEING INDEXED AT
  // (Story MOTIR-4669 · MOTIR-4724). Two facts nothing else can supply:
  //
  //  1. WHICH repository is indexing. `jobRunRepository` records why the ledger
  //     cannot say: a `running` row has no `output.repoRef`, because this job
  //     writes `output` only on success. So the claim goes on the REPO row.
  //  2. WHAT it is being indexed at. The head is read HERE, at the start, and
  //     stamped on success — never re-read at the end. A push landing mid-run
  //     then leaves the stored value behind the new head and the repository
  //     reads `stale`, which is the safe direction: over-reporting staleness
  //     costs a re-index, under-reporting it tells somebody their graph matches
  //     their code while they decide whether to trust a plan built from it.
  //
  // Best-effort and OUTSIDE the step seam: this is telemetry for a surface, and
  // an index that ran must never fail because a field write did not.
  const headAtStart = await claimIndexingRepo(ctx, target.repoRef);

  const coreTimings = await indexEveryProject(ctx, services, input, target, dispatchId);

  const result = await finishIndexRun(ctx, services, input, target, coreTimings);
  await settleIndexingRepo(target.repoRef, headAtStart);
  return result;
}

/**
 * Dispatch one container per project for this repo, and supervise each to its end.
 *
 * ⚠️ IT NO LONGER CONTAINS THE SUPERVISION — that was MOTIR-3484's collapse. The
 * admission backoff and the teardown live in
 * `codeGraphIndexDispatchService`, which this drives through the step seam. What
 * is left here is what is genuinely the JOB's: the per-repo fan-out over
 * projects, and turning a dispatch outcome into the ledger contract.
 *
 * ⚠️ AND THIS `for` LOOP IS NOW A CURSOR RATHER THAN A LOOP (MOTIR-3828), which
 * is the second loop in this path and the one that gets missed. A pass calls
 * `advanceIndexContainer` per project in order, and:
 *
 *   • a project that has ALREADY SETTLED replays — its `index-admit`,
 *     `index-boot` and `index-settle` memos answer from `job_step` and the
 *     driver's own row reads `settled`, so it performs NO provider read at all;
 *   • the first project that has NOT settled advances by exactly one poll and
 *     THROWS `JobRunDefer`, which unwinds out of this loop and hands the run
 *     back to the queue.
 *
 * So a pass costs a handful of memo reads plus ONE `describe`, whatever the
 * fan-out's width, and the next project's admission is asked for only once its
 * predecessor has settled — which is the sequencing the old `for` body had, now
 * expressed across runs. `docs/decisions/job-queue-foundation.md` §16.3 is the
 * arithmetic; the `(runId, subject)` key on `job_supervision` is what makes the
 * cursor expressible at all.
 */
async function indexEveryProject(
  ctx: JobContext,
  services: JobServices,
  input: IndexRepoInput,
  target: Extract<IndexTarget, { indexed: true }>,
  /** See its definition in {@link runIndexFleetSteps} — the cross-pass identity. */
  dispatchId: string,
): Promise<IndexCoreTimings[]> {
  const steps = stepSeam(ctx);

  // ⚠️ RE-DERIVED PER PASS, NEVER ACCUMULATED ACROSS THEM (MOTIR-4413). This
  // array is local, and being local is exactly why it is safe: the loop above
  // throws `JobRunDefer` out of this function until the LAST project has
  // settled, so the only pass that ever reaches the `return` is one on which
  // every `advanceIndexContainer` call replays its memos and hands back the
  // spans the working pass measured. The array is rebuilt from durable sources
  // on every pass and discarded on all but one; nothing is being carried.
  //
  // The distinction matters because the wrong version of this looks identical:
  // a `totalMs += …` in this scope would compile, pass a single-pass test, and
  // silently report the last pass's fragment in production, where a supervision
  // spans dozens of runs.
  const coreTimings: IndexCoreTimings[] = [];

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
      // INSIDE a memoized step, so a replay pass (which re-invokes the handler
      // with the same run) never re-mints against a different identity.
      runId: ctx.runId,
      // The dispatch's identity, which owns the ADMISSION SLOT (MOTIR-2160).
      // Computed once at the top of the handler — see it there for why it is the
      // event's id and not `ctx.runId`.
      dispatchId,
    };

    // ⚠️ THE CAP IS INSIDE, BEFORE ANY CONTAINER IS BOOTED.
    // `advanceIndexContainer` queues for admission first and
    // `bootIndexContainer` REQUIRES the ticket it hands back, so the global and
    // per-workspace bounds are structural rather than conventional — a type
    // error, not a review comment.
    //
    // ⚠️ IT ADVANCES ONE POLL AND USUALLY THROWS `JobRunDefer` (MOTIR-3828), so
    // this `for` body normally does not complete — see the fan-out block above
    // this function for what that means for the loop.
    const outcome: IndexDispatchOutcome =
      await services.codeGraphIndexDispatch.advanceIndexContainer(ctx.runId, dispatchInput, {
        steps,
      });

    // ⚠️ ONLY EXIT 0 INDEXED. `verdict.indexed` is true for that and nothing
    // else — an unobserved exit, a torn-down-but-unclassified run and a failed
    // teardown all leave it false — so this is the single place the run decides
    // whether the repo may be claimed. Every non-`settled` outcome (a deferred
    // admission, a refused provision, an unpullable image, a failed teardown)
    // reaches the same throw carrying its own discriminator.
    if (outcome.outcome !== 'settled' || !outcome.verdict.indexed) {
      throw dispatchFailure(target.repoRef, projectId, outcome);
    }

    // ⚠️ AFTER the throw, deliberately: a project that did not index contributes
    // no row. The run is about to fail anyway, and a `phasesMs` map for a
    // container that never indexed would sit in the ledger looking like the
    // measurement of a refresh that happened.
    //
    // ⚠️ AND AN EMPTY MAP CONTRIBUTES NOTHING EITHER. `coreSpansOf` returns
    // `{ phasesMs: {} }` when every source was missing — the in-flight-memo case
    // — and a row saying only "this project's spans are unknown" is noise on a
    // ledger row that many readers parse. Omit the project rather than record its
    // absence.
    if (outcome.coreTimings && Object.keys(outcome.coreTimings.phasesMs).length > 0) {
      coreTimings.push({ projectId, ...outcome.coreTimings });
    }
  }

  return coreTimings;
}

/**
 * The tail of a successful run — split out with {@link indexEveryProject} by
 * MOTIR-3358, and unchanged in behaviour.
 */
async function finishIndexRun(
  ctx: JobContext,
  services: JobServices,
  input: IndexRepoInput,
  target: Extract<IndexTarget, { indexed: true }>,
  /** The per-container core-side spans this run re-derived (MOTIR-4413). */
  coreTimings: IndexCoreTimings[],
): Promise<IndexRepoResult> {
  void services;
  // CANCEL any pending code-graph offboarding for this repo (MOTIR-2166 ·
  // `docs/decisions/code-graph-index-fleet.md` §14.3 — "a repo reconnected, or
  // RE-INDEXED, before its due date clears the queue row").
  //
  // The re-index arm matters independently of the re-connect one: a repo can be
  // indexed again without any connect event — a default-branch push runs
  // `system.code-graph-refresh` through this very function — and a graph that was
  // just rebuilt is plainly not one the tenant has finished with. Leaving the row
  // would delete a live, current index on a 30-day timer nobody could account for.
  //
  // Its OWN step, and the LAST one: it runs only when every project's container
  // exited 0 (the loop above throws otherwise), so a partial index never cancels a
  // removal it did not actually reverse. It KEEPS its step under §13.1's test —
  // it is a write, and it is the run's last act, so a resume past it should not
  // re-touch the offboarding queue. Quiet by construction — `cancelQuietly`
  // swallows, because a queue write must never fail an index that succeeded.
  await ctx.step.run('cancel-offboarding', async () => ({
    cancelled: await codeGraphOffboardingService.cancelQuietly({
      coreWorkspaceId: input.workspaceId,
      coreProjectIds: target.projectIds,
      repoRefs: [target.repoRef],
    }),
  }));

  // ⚠️ AND THE SUPERVISION ROWS GO (MOTIR-3826/3828). Every project has settled
  // by the time this line is reached — the loop above throws otherwise — so
  // `job_supervision` holds nothing but history for this run, and the outcome it
  // could tell anyone is already in `index-settle:<pid>`'s memo and in the run's
  // own `job_run` row. The table tracks LIVE supervisions; a second copy of a
  // settled one is a copy that ages.
  //
  // It reaches the repository through `withSystemContext` for the same reason
  // `lib/jobs/engine/step.ts` does: this is job-runtime code, running with no
  // workspace context bound, and without `app.system_admin` the policy hides
  // every untenanted row.
  await withSystemContext((tx) => jobSupervisionRepository.deleteByRun(ctx.runId, tx));

  // The ledger's row: ONE per repo, with ONE `output.repoRef`, reached only when
  // EVERY project's container exited 0.
  //
  // ⚠️ THE THREE FIELDS ARE UNCHANGED, AND `coreTimings` IS SPREAD IN ONLY WHEN
  // THERE IS SOMETHING TO SAY (MOTIR-4413). §6's contract is what
  // `listSucceededCodeGraphIndexRepoRefs` and the onboarding wizard read, and it
  // is not being widened — a fourth key rides ALONGSIDE it, optional, and absent
  // entirely on a run that could measure nothing. That absence is what keeps a
  // deployment mid-rollout honest: runs whose `index-admit` memo predates this
  // card produce exactly the row they produced before.
  return {
    indexed: true,
    repoRef: target.repoRef,
    projectsIndexed: target.projectIds.length,
    ...(coreTimings.length > 0 ? { coreTimings } : {}),
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

/**
 * Stamp the repository as indexing and read the head it is being indexed AT
 * (MOTIR-4724). Returns that head, or null when it is not known — a repository
 * nobody has pushed to since the column landed has none, and null is what stops
 * the settle below inventing a comparand.
 *
 * ⚠️ NEVER THROWS. It runs under `withSystemContext` for the reason every other
 * job-runtime read here does — no workspace is bound — and swallows its own
 * failure, because an index that ran is a fact and this is a note about it.
 */
async function claimIndexingRepo(ctx: JobContext, repoRef: string): Promise<string | null> {
  try {
    return await withSystemContext(async (tx) => {
      const [owner, name] = repoRef.split('/');
      if (!owner || !name) return null;
      const repo = await tx.githubRepo.findFirst({
        where: { owner, name },
        select: { defaultBranchHeadSha: true },
      });
      await githubRepoRepository.markIndexStarted(repoRef, ctx.runId, tx);
      return repo?.defaultBranchHeadSha ?? null;
    });
  } catch (err) {
    console.error('[index-fleet] could not claim the indexing repo', repoRef, err);
    return null;
  }
}

/** Release the claim, recording what was indexed when there is something to
 *  record. A run with no known head clears the claim and writes no sha — the row
 *  keeps its last real answer rather than gaining a false one. */
async function settleIndexingRepo(repoRef: string, headAtStart: string | null): Promise<void> {
  try {
    await withSystemContext((tx) =>
      githubRepoRepository.markIndexSettled(repoRef, { headSha: headAtStart }, tx),
    );
  } catch (err) {
    console.error('[index-fleet] could not settle the indexing repo', repoRef, err);
  }
}
