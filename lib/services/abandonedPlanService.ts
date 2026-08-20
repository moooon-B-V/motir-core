import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planRepository } from '@/lib/repositories/planRepository';
import { resolveJobState } from '@/lib/services/aiPlanEditsService';
import type { PlanJobStateDto } from '@/lib/dto/plans';

// ABANDONED-PLAN reconciliation (MOTIR-3064) — the recovery half of the
// generation lifecycle, and the answer to a hole MOTIR-3051 named and left open
// on purpose.
//
// THE DEFECT. Nothing writes a terminal `Plan` status when a motir-ai job dies:
// motir-ai's inbound seams into core are the success path (`appendProposals` /
// `patchProposal`), so a job that fails, is canceled, or whose process vanishes
// changes nothing about the plan it was producing into. That plan sits at
// `generating` — and `planRepository.findUndecidedByProject` reads `generating`
// as UNDECIDED, which is the pending-proposal gate `autoPlanCadenceService`
// checks FIRST. So a dead job silently paused that project's auto-plan cadence
// permanently, with the AI-planning settings page reporting a proposal waiting
// for a decision nobody could make.
//
// WHY IT IS A SWEEP AND NOT A CALLBACK. The card offered two shapes, and only one
// of them exists. Writing the terminal status "on job failure" needs a failure
// callback, and there is none: core learns a job's outcome by ASKING
// (`resolveJobState` → `GET /v1/jobs/:id`) or by holding an SSE stream open.
// Adding an inbound failure route would still not cover the case that matters
// most — a motir-ai process that dies mid-job writes no callback at all
// (`src/jobs/worker.ts` marks `failed` only when the HANDLER throws; a claimed
// job whose worker vanishes stays `running`). A sweep that asks covers both, so
// it is the whole fix rather than half of one.
//
// WHY IT CANNOT BE A WIDER GATE PREDICATE — the thing MOTIR-3051 could do and
// this cannot. That card excluded the orphan with NO producer, which is judgeable
// from the row itself. This orphan carries a `sourceJobId`, so it is byte-for-byte
// what a healthy generation looks like between `createPlan` and its first append.
// The discriminator is not in the plan table; it is whether the job behind it is
// still alive. `docs/decisions/agent-authored-plans.md` AMENDMENT 2 records the
// decision and the rejected alternatives.
//
// ⚠️ IT IS NO LONGER EMPTY-ONLY (MOTIR-3189, AMENDMENT 6). AMENDMENT 2 left
// PARTIAL plans alone on the ground that one is *"a real proposal a person can
// read and decline"*. Read, yes — decline, no: `declinePlan` and `approvePlan`
// each re-read under their row lock and refused anything but `planned`, so there
// was no path out of `generating` for anyone, and every partial plan was
// stranded exactly as permanently as the empty ones this sweep was written for.
// The valve exists now (`declinePlan` accepts `generating` and records
// `discarded`), and this sweep takes the partial plans nobody is coming back to.
// Nothing else about the decision table moved: the three KEEP arms terminate
// nothing, the 15-minute grace still holds the sweep out of the
// submit→first-append window, and a partial plan behind a LIVE job is left
// alone by `job_in_flight` exactly as an empty one is.
//
// ⚠️ AND THE SELECTION HAS MOVED OUT OF SQL (MOTIR-3236, AMENDMENT 7). The
// paragraph above says a wider GATE predicate cannot work, and that is still
// true of `findUndecidedByProject`. What changed is this sweep's DISCOVERY
// predicate, which used to carry `sourceJobId: { not: null }` and so could never
// see an MCP-authored plan at all — one has no generation job by construction
// (`create_plan`, MOTIR-2982), so the two sets were disjoint and the hourly pass
// ran past those rows for ever. AMENDMENT 4 named that debt and declined to pay
// it; this is where it is paid.
//
// The fix is a RE-SHAPE, not a fourth widening. The predicate had become a
// whitelist of the plan shapes the sweep knew how to judge, so every newly
// recognised shape cost a query change (MOTIR-3051, MOTIR-3064, MOTIR-3189,
// then this). Now the predicate selects every `generating` plan past the grace
// and `classifyAbandonedCandidate` DECIDES — `sourceJobId` is an input to the
// table, not a condition of selection. The next unrecognised shape is a new arm
// in a pure function with a unit test.
//
// The new arm is `no_producer`: nothing to ask, so the only signal is the
// passage of time — which is precisely the argument `max_age` already makes for
// a crashed worker, and it REUSES `ABANDONED_PLAN_MAX_AGE_HOURS` rather than
// inventing a second threshold. Under the max age it is `no_producer_recent`
// and kept, because an author mid-skeleton looks exactly like one who stopped.
// `docs/decisions/agent-authored-plans.md` AMENDMENT 7 records it, including
// the sentence in AMENDMENT 6 it supersedes.
//
// System-scoped: the discovery read spans workspaces (the plan policy's
// `FOR SELECT` `app.system_admin` arm, added by this card's migration for exactly
// this), and every WRITE then re-binds `app.workspace_id` to that row's own
// workspace — so no write is ever untenanted and the cross-tenant write refusal
// stays load-bearing.

/**
 * How old a producer-bearing `generating` plan must be before the sweep will
 * even ASK about it.
 *
 * A CORRECTNESS bound, not a performance one. Between `submitExpand`'s
 * `createPlan` and motir-ai's first append, a perfectly healthy plan holds zero
 * items with a live job — the exact shape this sweep selects. The grace keeps it
 * out of that window, so it can never be asking about a submit that happened
 * milliseconds ago. Fifteen minutes is far longer than any observed
 * submit→first-append gap and far shorter than the hourly cadence tick whose
 * pause it exists to lift.
 */
export const ABANDONED_PLAN_GRACE_MINUTES = 15;

/**
 * How long a plan may sit behind a job that never reaches a terminal state
 * before the sweep treats it as abandoned anyway.
 *
 * This is the arm for the failure the ASK cannot see: a motir-ai worker that
 * dies mid-job leaves its row `running` forever, so `resolveJobState` answers
 * "still working" for all time and the plan would gate for all time with it. It
 * is the same argument `planTargetLockSweep` makes about a crashed planner —
 * "the only signal left is the passage of time" — applied to the row that crash
 * strands here.
 *
 * Deliberately a DAY rather than an hour: a long-running generation is a normal
 * thing and cutting one off would destroy work, while a paused cadence costs a
 * project one day of suggestions. The asymmetry picks the number.
 */
export const ABANDONED_PLAN_MAX_AGE_HOURS = 24;

/** Plans reconciled per pass — bounded, so a backlog drains over successive
 *  ticks rather than holding one long pass over a large slice of the table. */
export const ABANDONED_PLAN_SWEEP_BATCH_SIZE = 50;

/** Why a candidate was terminated. Every one of these means the producer is not
 *  coming back; they differ only in how we found out. */
export type AbandonReason =
  /** The job reached a terminal state — the reported case (`failed`), plus the
   *  two that are equally final (`canceled`, and a `succeeded` job that
   *  nonetheless never marked the plan `planned` — whether it appended nothing
   *  or stopped part-way). */
  | 'job_terminal'
  /** motir-ai has no such job (404). The producer is gone, not merely quiet. */
  | 'job_gone'
  /** The job never reached a terminal state and the plan is older than
   *  {@link ABANDONED_PLAN_MAX_AGE_HOURS} — the crashed-worker arm. */
  | 'max_age'
  /** There is NO producer to ask about (`sourceJobId` is null — an MCP-authored
   *  plan, MOTIR-2982) and the plan is older than
   *  {@link ABANDONED_PLAN_MAX_AGE_HOURS}. The only signal a job-less plan
   *  offers is the passage of time, which is the same argument `max_age` makes
   *  for a job that never answered — hence the same constant, not a second one.
   *  Kept as its own reason because the two are found out DIFFERENTLY: `max_age`
   *  asked and was told nothing useful; this one had nobody to ask. */
  | 'no_producer';

/** Why a candidate was left alone. */
export type KeepReason =
  /** `queued` / `running` inside the max age — a live run, which MUST keep
   *  gating (the tick's `retryPolicy: 'idempotent'` depends on it). */
  | 'job_in_flight'
  /** motir-ai could not be reached. Unreachable is not evidence of death, and
   *  the next tick asks again. */
  | 'ai_unreachable'
  /** The row changed under us between discovery and the write — proposals
   *  arrived, or somebody decided it. */
  | 'row_moved'
  /** No producer, and still inside {@link ABANDONED_PLAN_MAX_AGE_HOURS} — an
   *  agent that is mid-skeleton right now looks exactly like one that stopped,
   *  and the grace alone is far too short to tell them apart. This is the KEEP
   *  arm that makes `no_producer` safe: an author has a full day to close the
   *  plan before anything touches it. */
  | 'no_producer_recent';

export type AbandonedPlanOutcome =
  | { planId: string; projectId: string; outcome: 'declined'; reason: AbandonReason }
  | { planId: string; projectId: string; outcome: 'left_as_is'; reason: KeepReason };

export interface AbandonedPlanSweepSummary {
  /** Candidate plans examined this pass. */
  scanned: number;
  /** Candidates moved to `declined`. */
  declined: number;
  outcomes: AbandonedPlanOutcome[];
}

/** The job resolver, behind a seam so a unit test can drive the decision table
 *  without a live motir-ai. Production uses the shipped one. */
export interface AbandonedPlanDeps {
  resolveJobState: typeof resolveJobState;
}

const defaultDeps: AbandonedPlanDeps = {
  resolveJobState: (jobId, coreProjectId) => resolveJobState(jobId, coreProjectId),
};

/** motir-ai's terminal job states. A job in ANY of them is done talking — the
 *  plan it was producing into will never be finished, whichever way it ended and
 *  however much of it the job managed to append first. */
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

/**
 * The DECISION TABLE, pure and separated from the I/O so it can be read as one
 * thing: given what the job said and how old the plan is, is the producer coming
 * back?
 */
export function classifyAbandonedCandidate(
  job: PlanJobStateDto | null,
  ageMs: number,
): { abandoned: true; reason: AbandonReason } | { abandoned: false; reason: KeepReason } {
  // NO PRODUCER (MOTIR-3236) — `job` is null because the plan carries no
  // `sourceJobId` and there was nothing to ask. An MCP-authored plan is written
  // this way by construction (`create_plan` has no job), so this is not a
  // degenerate case: it is the whole shape of one of the two ways a plan gets
  // written.
  //
  // AMENDMENT 2's argument for asking — "the discriminator is not in the plan
  // table" — is TRUE of a producer-bearing plan and FALSE here. An ABSENT
  // producer IS a fact about the row, and it is the fact that settles the
  // question: there is no job that could come back, so the only signal left is
  // the passage of time. That is exactly the argument `max_age` already makes
  // for the crashed worker, which is why this arm REUSES
  // `ABANDONED_PLAN_MAX_AGE_HOURS` rather than introducing a threshold of its
  // own.
  if (job === null) {
    if (ageMs >= ABANDONED_PLAN_MAX_AGE_HOURS * 60 * 60 * 1000) {
      return { abandoned: true, reason: 'no_producer' };
    }
    return { abandoned: false, reason: 'no_producer_recent' };
  }
  // A 404 is the one unreachable-shaped answer that IS evidence: motir-ai
  // answered, and its answer was that no such job exists.
  if (!job.reachable) {
    if (job.failure?.code === 'MOTIR_AI_JOB_NOT_FOUND') {
      return { abandoned: true, reason: 'job_gone' };
    }
    return { abandoned: false, reason: 'ai_unreachable' };
  }
  if (job.status && TERMINAL_JOB_STATUSES.has(job.status)) {
    return { abandoned: true, reason: 'job_terminal' };
  }
  if (ageMs >= ABANDONED_PLAN_MAX_AGE_HOURS * 60 * 60 * 1000) {
    return { abandoned: true, reason: 'max_age' };
  }
  return { abandoned: false, reason: 'job_in_flight' };
}

export const abandonedPlanService = {
  /**
   * One reconciliation pass: find every `generating` plan whose producer has had
   * its grace, ask motir-ai what became of that producer, and DECLINE the ones
   * it is not coming back to. Empty or PARTIAL alike since MOTIR-3189 — what
   * decides is the JOB, not what the plan managed to hold before it died.
   *
   * WHY `declined` AND NOT A NEW `failed` STATE — the decision this card was
   * asked to make, recorded in full in AMENDMENT 2 and in one line here because
   * this is where a reader meets it. `PlanStatus` is a PUBLIC vocabulary: the v1
   * work-loop `planStatusSchema`, the MCP tool descriptions, `PlanStatusDto` and
   * four display switches plus the i18n catalogue and its zh-parity gate. A new
   * member is a product decision about what people are shown, larger than this
   * defect and owed its own card — and nothing downstream would branch on it,
   * because every consumer of this row is asking "is it decided?", which
   * `declined` answers. The honesty lives in the ACTOR: `decidedById` is NULL,
   * which on this very table already means *nobody* (`Plan.createdById` is null ⟺
   * nobody asked, the cadence case, documented in the schema). The failure itself
   * is not lost — `sourceJobId` still points at the job, whose state and error
   * stay readable through {@link resolveJobState}, and each outcome is logged.
   *
   * ⚠️ AND SINCE MOTIR-3189 IT IS ALSO RECORDED, not merely derivable: the write
   * sets `decisionReason: 'abandoned'`. That paragraph's fallback — the null
   * decider — was doing the work of a column, and `declined` covers three
   * different histories (a person rejected a finished plan; a person discarded
   * one mid-generation; this sweep terminated a dead producer) that the review
   * surface rendered identically. `PlanStatus` is still not the place to say so,
   * for every reason above; a PRIVATE column is.
   *
   * PLANNING-TARGET LOCKS are deliberately not released here. `plansService`
   * releases them on approve/decline through a best-effort helper that needs an
   * acting user this sweep does not have, and its own fallback is already the
   * right one: "the lease will expire and the sweep will clear it"
   * (`planTargetLockSweep`, every 10 minutes). Two recovery paths for one lease
   * is how they drift.
   */
  async reconcileAbandoned(
    opts: { now?: Date; batchSize?: number; deps?: AbandonedPlanDeps } = {},
  ): Promise<AbandonedPlanSweepSummary> {
    const now = opts.now ?? new Date();
    const batchSize = opts.batchSize ?? ABANDONED_PLAN_SWEEP_BATCH_SIZE;
    const deps = opts.deps ?? defaultDeps;
    const olderThan = new Date(now.getTime() - ABANDONED_PLAN_GRACE_MINUTES * 60 * 1000);

    const candidates = await withSystemContext((tx) =>
      planRepository.listAbandonedCandidates(olderThan, batchSize, tx),
    );
    if (candidates.length === 0) return { scanned: 0, declined: 0, outcomes: [] };

    const outcomes: AbandonedPlanOutcome[] = [];
    for (const plan of candidates) {
      // ASK only when there is somebody to ask (MOTIR-3236). A candidate with no
      // `sourceJobId` gets NO `resolveJobState` call: asking motir-ai about a job
      // id that does not exist is a request that can only 404, and a 404 already
      // MEANS something else here — `job_gone`, the producer that existed and is
      // now provably dead. Sending one would launder "there was never a job" into
      // "the job died", on every pass, for every MCP-authored plan.
      //
      // When there IS one, the ask happens outside any transaction: it is a
      // network call to motir-ai, and a slow one must never be holding a row.
      const job = plan.sourceJobId
        ? await deps.resolveJobState(plan.sourceJobId, plan.projectId)
        : null;
      const verdict = classifyAbandonedCandidate(job, now.getTime() - plan.createdAt.getTime());

      if (!verdict.abandoned) {
        outcomes.push({
          planId: plan.id,
          projectId: plan.projectId,
          outcome: 'left_as_is',
          reason: verdict.reason,
        });
        continue;
      }

      const written = await withWorkspaceServiceContext(plan.workspaceId, async (tx) => {
        // RE-READ under the transaction that will act. The candidate came out of
        // a different transaction's snapshot and the network call above took real
        // time, so a human decision could have landed since.
        const fresh = await planRepository.findById(plan.id, plan.workspaceId, tx);
        if (!fresh || fresh.status !== 'generating') return false;
        // AND RE-COUNT, comparing against what discovery saw (MOTIR-3189). This
        // used to read `items > 0`, which was correct only while the predicate
        // guaranteed zero; a partial plan is now a legitimate candidate, so the
        // question is no longer "does it hold anything" but "did it MOVE". A
        // proposal that arrived during the ask means the producer was alive after
        // the job said otherwise — leave it, exactly as before. It is also what
        // makes an RLS blind spot in the cross-workspace discovery scan fail
        // SAFE: a hidden proposal reads the count low there and this re-count,
        // bound to the plan's own workspace, disagrees.
        const items = await tx.planItem.count({ where: { planId: plan.id } });
        if (items !== plan._count.items) return false;
        await planRepository.update(
          plan.id,
          // No `decidedById`: nobody decided this. See the method doc. The
          // `decisionReason` is what says so on the row rather than leaving it to
          // be inferred from which timestamps are null.
          { status: 'declined', decidedAt: now, decisionReason: 'abandoned' },
          tx,
        );
        return true;
      });

      if (!written) {
        outcomes.push({
          planId: plan.id,
          projectId: plan.projectId,
          outcome: 'left_as_is',
          reason: 'row_moved',
        });
        continue;
      }

      // `warn`, not `info`: the repo's lint allows only warn/error, and the level
      // is right anyway — a plan terminated with nobody's decision behind it is
      // the operator-visible record of a job that died, not routine chatter.
      // The producer half of the line tells the truth about which of the two
      // shapes this was: a job that was asked about and reported something, or a
      // plan that never had one. Printing `job null` and a job status for a
      // job-less plan would read as a failed lookup rather than an absent
      // producer, which is the distinction the whole `no_producer` arm turns on.
      const producer = job
        ? `job ${plan.sourceJobId}; job status ${job.status ?? 'unreachable'}${
            job.failure ? ` (${job.failure.code})` : ''
          }`
        : 'no producer (agent-authored — no generation job to ask about)';
      console.warn(
        `[abandoned-plan-sweep] plan ${plan.id} (project ${plan.projectId}) declined as abandoned — ${verdict.reason}; ${plan._count.items} proposal(s) retained; ${producer}`,
      );
      outcomes.push({
        planId: plan.id,
        projectId: plan.projectId,
        outcome: 'declined',
        reason: verdict.reason,
      });
    }

    return {
      scanned: outcomes.length,
      declined: outcomes.filter((o) => o.outcome === 'declined').length,
      outcomes,
    };
  },
};
