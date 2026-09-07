import type { ProjectContext } from '@/lib/projects';
import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type { JobStreamEvent } from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { readAskOutcome } from '@/lib/planning/askResult';
import { EmptyPlanChangeTurnError, PlanChangeTurnNotFoundError } from '@/lib/planChange/errors';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import { pendingQuestion } from '@/lib/planning/planChangeThread';

// The ASK seam (Story MOTIR-1343 · MOTIR-1819) — the motir-core side of "Ask
// about this project".
//
// ⚠️ IT IS THE COMPOSER'S ONE DOOR, not an "ask-only" endpoint the client picks
// when it already knows. `docs/decisions/conversation-turn-intent.md` §1/§2
// (decided by MOTIR-1816): the client posts the TEXT and never an intent, and
// what the turn turns out to be is the JOB'S answer, not the caller's claim.
// Every user turn is submitted as `ask_project`; motir-ai's handler classifies on
// its first turn and either answers or hands the turn back as
// `intent: 'plan_change'`, at which point {@link aiAskService.settle} dispatches
// the SHIPPED plan-change submit for the same turn. That route, its service and
// the `augment` contract are untouched — they gain a caller, not a behaviour.
//
// ── WHY THE SETTLE IS A SEPARATE CALL ────────────────────────────────────────
// Nothing in core observes a motir-ai job finishing: the run is watched by the
// BROWSER's SSE subscription, and motir-ai calls no webhook back. So the client
// that saw the stream settle is the one that tells the server to go read the
// result and file it — exactly the shape `recordPlannerTurn` already takes for
// the planner's own turn. That makes the call REPLAYABLE by construction (a
// reload, a second tab, a retried settle), which is why the answer append is
// keyed on the job id and the user turn is keyed on it too.
//
// ── SIDE EFFECTS OUTSIDE THE TRANSACTION (CLAUDE.md) ─────────────────────────
// Submitting and reading a job are network calls; appending a turn is a DB
// write. They never share a transaction — the turn is appended, then the job is
// submitted, then the turn is bound to it. A submit that fails therefore leaves
// the person's words ON the thread rather than dropping them: the thread is the
// record, the rail's shipped error state is recoverable in place, and
// {@link aiAskService.resubmit} re-runs the SAME turn without appending a second.
//
// ── SCOPE: THE PROJECT-WIDE THREAD, DELIBERATELY ─────────────────────────────
// Every call here works the project's ONE conversation (`scopeKey = ''`), not an
// item-ANCHORED thread. The shipped contextual path (7.12.3 · MOTIR-909) is
// untouched and keeps its own submit; the intent decision settled how a turn is
// CLASSIFIED, and said nothing about anchoring an ask at a work-item set, so
// widening this to anchored threads would be deciding that here rather than
// where it belongs. An anchored ask is a follow-up, not an omission.

/** What a submitted ask turn tells the caller: the job to stream, and the turn
 *  the settle will key on. The session comes back too, so the rail renders the
 *  new turn from the server's copy rather than an optimistic guess. */
export interface AskSubmitResult {
  jobId: string;
  turnId: string;
  session: PlanChangeSessionDto;
}

/**
 * What a settled ask turn produced. Exactly one of three states, and they are
 * kept apart deliberately because the rail renders each differently:
 *
 *  * `answered` — an `assistant` turn is on the thread, with its citations.
 *  * `redirected` — the turn was a plan change; `jobId` / `planId` name the
 *    plan-edit job now running, and the shipped diff + confirm chrome takes over.
 *  * `silent` — the job ran and said nothing at all. Core persists NOTHING for
 *    this: an assistant turn needs a body, and inventing one would mean motir-core
 *    writing the assistant's words. (An honest "I could not find that" is prose
 *    the handler DOES return, and lands as an ordinary answer with no citations —
 *    that is `answered`, not this.)
 */
/** A turn that did NOT open an ask job: it went straight to the shipped
 *  plan-change submit, and `jobId` / `planId` name the plan-edit job now
 *  running. Both entrances can produce it — {@link aiAskService.submitTurn} when
 *  the turn answers a pending question, and {@link aiAskService.resubmit} when
 *  the handler hands a turn back. */
export interface AskRedirectResult {
  outcome: 'redirected';
  jobId: string;
  planId: string;
  session: PlanChangeSessionDto;
}

export type AskSettleResult =
  | { outcome: 'answered'; session: PlanChangeSessionDto }
  | { outcome: 'redirected'; jobId: string; planId: string; session: PlanChangeSessionDto }
  | { outcome: 'silent'; session: PlanChangeSessionDto };

function tenantFor(
  ctx: ProjectContext,
  organizationId: string,
  isMeta: boolean,
  internalBilling: boolean,
) {
  return {
    organizationId,
    isMeta,
    internalBilling,
    workspaceId: ctx.workspaceId,
    projectId: ctx.projectId,
    projectKey: ctx.project.identifier,
  };
}

/** Submit ONE `ask_project` job for `prompt`. The gate + tenant resolution are
 *  the shipped ones (`aiChatService.submitDiscoveryTurn`'s shape); nothing about
 *  metering or availability is re-implemented here. */
async function submitAsk(prompt: string, ctx: ProjectContext): Promise<{ jobId: string }> {
  const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return submitJob(
    'ask_project',
    tenantFor(ctx, organizationId, isMeta, internalBilling),
    { prompt },
    {
      userId: ctx.userId,
    },
  );
}

/** The thread's turn with this id, from a session DTO. */
function turnById(session: PlanChangeSessionDto, turnId: string): PlanChangeTurnDto | null {
  return session.turns.find((t) => t.id === turnId) ?? null;
}

/** The `user` turn a job was submitted for, or null. The settle's key. */
function turnByJobId(session: PlanChangeSessionDto, jobId: string): PlanChangeTurnDto | null {
  return session.turns.find((t) => t.role === 'user' && t.jobId === jobId) ?? null;
}

export const aiAskService = {
  /**
   * The composer's door: append what the person typed, then run it.
   *
   * The turn is appended with `intent: 'ask'` because that is what is ABOUT to
   * run — the field records the EFFECTIVE disposition, not a guess — and moves to
   * `plan_change` at settle if the handler hands it back. `jobId` binds the turn
   * to its job in a second, locked write, because the job does not exist until
   * after the append.
   */
  async submitTurn(
    body: string,
    ctx: ProjectContext,
    opts: { isAnswer?: boolean } = {},
  ): Promise<AskSubmitResult | AskRedirectResult> {
    const trimmed = body.trim();
    if (!trimmed) throw new EmptyPlanChangeTurnError();

    // `ai:plan` — the same key the plan-change submit asserts, and for the same
    // reason: an ask turn spends the workspace's AI credits.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );

    // OPEN OR RESUME the thread first — the door is self-sufficient. The rail
    // opens the thread on mount today, but a door that only works after another
    // call has run is a door with an undocumented precondition, and the
    // get-or-create is idempotent (the `(project_id, scope_key)` unique makes a
    // lost create-race read the winner's row).
    const current = await planChangeSessionsService.getOrCreateForProject(ctx);

    // ── ⭐ AN ANSWER TO A PENDING QUESTION SKIPS THE CLASSIFIER ──────────────
    //
    // `isAnswer` rides through because ADR §1's wire table says it does, and it
    // is NOT an intent: it records WHICH AFFORDANCE sent the turn. That is
    // exactly what makes it decisive here — the disposition is already known,
    // and it was recorded in the first place BECAUSE it cannot be re-derived
    // from the words.
    //
    // Classifying anyway is the expensive half of §4's asymmetry. A reply to a
    // blocking question is usually a fragment ("money in") that is neither a
    // question nor a request, so the default lands on `ask`, Motir answers it as
    // a project question, the planner's question stays pending forever and the
    // run never resumes — a thread the user has to un-stick by hand, which it
    // never needed before this door became the only one.
    //
    // ⚠️ THE FLAG ALONE IS NOT TRUSTED, which is what keeps the intent
    // server-resolved (§1). A client claiming `isAnswer` is honoured only when
    // the thread ACTUALLY has a pending question — the same derivation the rail
    // uses to decide whether to show the answer bar at all. Without that check
    // this would be a client-supplied intent wearing another name, which is the
    // back door §5 exists to close.
    const answersAQuestion = opts.isAnswer === true && pendingQuestion(current.turns) !== null;
    if (answersAQuestion) {
      await planChangeSessionsService.appendTurn(trimmed, ctx, undefined, {
        // What actually RAN. The field records the effective disposition, and
        // what runs on this branch is the plan-change submit, not an ask.
        intent: 'plan_change',
        isAnswer: true,
      });
      // The SHIPPED submit, untouched: it accumulates every user turn in order,
      // which is how answering RESUMES the run rather than restarting it.
      const submitted = await planChangeSessionsService.submit(ctx);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    const appended = await planChangeSessionsService.appendTurn(trimmed, ctx, undefined, {
      intent: 'ask',
      // Recorded even here: a turn sent from the answer bar when nothing was
      // pending is still a fact about the affordance, and the transcript keeps
      // facts rather than tidying them away.
      isAnswer: opts.isAnswer === true,
    });
    const turn = appended.turns.at(-1);
    if (!turn) throw new PlanChangeTurnNotFoundError('(the turn just appended)');

    const { jobId } = await submitAsk(trimmed, ctx);
    const session = await planChangeSessionsService.recordTurnIntent(turn.id, 'ask', ctx, {
      jobId,
    });
    return { jobId, turnId: turn.id, session };
  },

  /**
   * Re-run a turn that is already on the thread — the RETRY after a failed
   * submit, and the CORRECTION affordance (ADR §3), which are the same write with
   * different bookkeeping.
   *
   * `flip: true` is the correction: the turn runs under the OTHER intent, and
   * `intentCorrected` latches. The DIRECTION is never supplied by the client —
   * it is derived from what the turn currently ran as, which is what keeps the
   * intent server-resolved (§1) even when a person is the one asking for the
   * change.
   *
   * No second `user` turn is ever appended: the person said one thing once.
   */
  async resubmit(
    turnId: string,
    ctx: ProjectContext,
    opts: { flip?: boolean } = {},
  ): Promise<AskSubmitResult | AskRedirectResult> {
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );

    const current = await planChangeSessionsService.getOrCreateForProject(ctx);
    const turn = turnById(current, turnId);
    if (!turn || turn.role !== 'user') throw new PlanChangeTurnNotFoundError(turnId);

    const ran = turn.intent ?? 'ask';
    const next = opts.flip ? (ran === 'ask' ? 'plan_change' : 'ask') : ran;

    if (next === 'plan_change') {
      // Hand it to the SHIPPED plan-change submit. Untouched: it accumulates the
      // thread's user turns exactly as it always has.
      await planChangeSessionsService.recordTurnIntent(turnId, 'plan_change', ctx, {
        corrected: opts.flip === true,
      });
      const submitted = await planChangeSessionsService.submit(ctx);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    const { jobId } = await submitAsk(turn.body, ctx);
    const session = await planChangeSessionsService.recordTurnIntent(turnId, 'ask', ctx, {
      corrected: opts.flip === true,
      jobId,
    });
    return { jobId, turnId, session };
  },

  /**
   * Read a settled `ask_project` job and file what it produced.
   *
   * REPLAYABLE: the answer append is idempotent on the job id, and the redirect
   * arm is guarded by the turn's current intent, so a second settle of the same
   * job neither duplicates a bubble nor dispatches a second plan-edit job.
   */
  async settle(jobId: string, ctx: ProjectContext): Promise<AskSettleResult> {
    const session = await planChangeSessionsService.getOrCreateForProject(ctx);
    const turn = turnByJobId(session, jobId);
    // A job id this thread never submitted is not an error — the client may be
    // replaying a stale settle after a newer turn — so it yields the thread as it
    // stands, the same disposition `recordPlannerTurn` takes for a mismatch.
    if (!turn) return { outcome: 'silent', session };

    const job = await getJob(jobId, ctx.projectId);
    const outcome = readAskOutcome(job.result);
    if (!outcome) return { outcome: 'silent', session };

    if (outcome.intent === 'plan_change') {
      // Already redirected by an earlier settle of this same job — do not submit
      // a second plan-edit job for one turn.
      if (turn.intent === 'plan_change') return { outcome: 'silent', session };
      await planChangeSessionsService.recordTurnIntent(turn.id, 'plan_change', ctx, {});
      const submitted = await planChangeSessionsService.submit(ctx);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    if (!outcome.answer) return { outcome: 'silent', session };

    const updated = await planChangeSessionsService.appendAnswerTurn(
      { jobId, body: outcome.answer, citations: outcome.citations },
      ctx,
    );
    return { outcome: 'answered', session: updated };
  },

  /** The live channel the rail subscribes to — the shipped job stream, relayed. */
  streamAsk(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },
};
