import type { ProjectContext } from '@/lib/projects';
import { submitJob, streamJob, getJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { MotirAiConfigError } from '@/lib/ai/errors';
import type { JobContextBag, JobKind, JobStreamEvent } from '@/lib/ai/types';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { readAskOutcome } from '@/lib/planning/askResult';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  AskAnchorNotAvailableError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnNotFoundError,
} from '@/lib/planChange/errors';
import { PROJECT_SCOPE, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
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
//
// ── THE ANCHOR (MOTIR-7047 · the ADR's AMENDMENT 1, A1.2) ────────────────────
// A turn MAY name ONE work item it is about (`anchorKey`) — usually the triage
// bug the person just reported. It does NOT move the turn off the project-wide
// thread; it is DATA the job reads: the classifier is told the turn is anchored
// there, and a `debug` verdict echoes it back so `debug_bug` gets it too. The key
// is resolved through the KEYED read (`workItemsService.getWorkItemByIdentifier`,
// which includes triage rows — only LIST reads exclude them) and browse-gated,
// pinned to the active project, on the way IN and again at the debug dispatch,
// because the echo is a claim from across the boundary, not a fact.
//
// ── THE DEBUG ARM (MOTIR-7047 · AMENDMENT 1, A1.1 / A1.4) ────────────────────
// A settled `ask_project` job that redirects with `intent: 'debug'` is dispatched
// as ONE `debug_bug` job for the same turn. The turn's `jobId` is then rebound to
// the debug job — the job that actually ran for it — so a reload finds the running
// diagnosis on the thread, and the job that LANDS it (MOTIR-7049) can key on it.

/** What a submitted ask turn tells the caller: the job to stream, and the turn
 *  the settle will key on. The session comes back too, so the rail renders the
 *  new turn from the server's copy rather than an optimistic guess. */
export interface AskSubmitResult {
  jobId: string;
  turnId: string;
  session: PlanChangeSessionDto;
}

/**
 * What a settled ask turn produced. Exactly one of four states, and they are
 * kept apart deliberately because the rail renders each differently:
 *
 *  * `answered` — an `assistant` turn is on the thread, with its citations.
 *  * `redirected` — the turn was a plan change; `jobId` / `planId` name the
 *    plan-edit job now running, and the shipped diff + confirm chrome takes over.
 *  * `debugging` — the turn reported broken behaviour (MOTIR-7047); `jobId`
 *    names the `debug_bug` job now running ({@link AskDebugResult}).
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

/** A turn Motir read as a REPORT OF BROKEN BEHAVIOUR (MOTIR-7047): `jobId` names
 *  the `debug_bug` job now diagnosing it, which the rail streams exactly as it
 *  streams an ask (`GET /api/ai/ask/[jobId]/stream`). Nothing is landed yet —
 *  that is the debug job's own settle (MOTIR-7049). */
export interface AskDebugResult {
  outcome: 'debugging';
  jobId: string;
  session: PlanChangeSessionDto;
}

export type AskSettleResult =
  | { outcome: 'answered'; session: PlanChangeSessionDto }
  | { outcome: 'redirected'; jobId: string; planId: string; session: PlanChangeSessionDto }
  | AskDebugResult
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

/** Submit ONE conversation job (`ask_project`, or `debug_bug` for a debug turn).
 *  The gate + tenant resolution are the shipped ones
 *  (`aiChatService.submitDiscoveryTurn`'s shape); nothing about metering or
 *  availability is re-implemented here — an out-of-credits org surfaces as the
 *  client's typed `MotirAiOutOfCreditsError`. */
async function submitConversationJob(
  kind: Extract<JobKind, 'ask_project' | 'debug_bug'>,
  prompt: string,
  anchorKey: string | null,
  ctx: ProjectContext,
): Promise<{ jobId: string }> {
  const { organizationId, isMeta, internalBilling } = await resolveTenantOrg({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const context: JobContextBag = { prompt, ...(anchorKey ? { anchorKey } : {}) };
  return submitJob(kind, tenantFor(ctx, organizationId, isMeta, internalBilling), context, {
    userId: ctx.userId,
  });
}

function submitAsk(
  prompt: string,
  anchorKey: string | null,
  ctx: ProjectContext,
): Promise<{ jobId: string }> {
  return submitConversationJob('ask_project', prompt, anchorKey, ctx);
}

/**
 * Resolve a turn's anchor to its identifier, or refuse it (MOTIR-7047).
 *
 * The KEYED read, pinned to the ACTIVE project: `getWorkItemByIdentifier` looks
 * the key up by `(projectId, identifier)`, so another project's key simply does
 * not resolve; it checks the workspace and asserts browse. It does NOT exclude
 * triage items — that exclusion belongs to LIST reads — which is exactly what
 * makes a triage bug a legal anchor (ADR AMENDMENT 1, A1.2) without a new read.
 *
 * Every "not for you" collapses into ONE typed 404, the planning-anchor route's
 * no-existence-leak answer.
 */
async function resolveAnchor(anchorKey: string, ctx: ProjectContext): Promise<string> {
  try {
    const item = await workItemsService.getWorkItemByIdentifier(ctx.projectId, anchorKey, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return item.identifier;
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      throw new AskAnchorNotAvailableError();
    }
    throw err;
  }
}

/**
 * The gates a DEBUG dispatch adds, all asserted BEFORE the turn's intent moves
 * and before any job is submitted, so a refusal leaves the thread exactly as it
 * stood and spends nothing.
 *
 *  * `ai:plan` — the key every conversation job spends credits under.
 *  * `work_item:edit` — a debug turn WRITES one card as the sender (A1.4), so the
 *    sender must be able to edit cards by hand. Asserted HERE, at the dispatch,
 *    and NOT at the ask door: the door cannot know a turn is a debug until the
 *    classifier has run, and a member who may ask but not edit must keep getting
 *    answers. A typed `PermissionDeniedError` → 403.
 *  * Motir AI configured — checked explicitly because the settle arm moves the
 *    turn's intent BEFORE it submits; the client's own config throw would come
 *    one write too late.
 */
async function assertCanDebug(ctx: ProjectContext): Promise<void> {
  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  await projectAccessService.assertPermission(ctx.projectId, actor, 'ai:plan');
  await projectAccessService.assertPermission(ctx.projectId, actor, 'work_item:edit');
  if (!isMotirAiConfigured()) {
    throw new MotirAiConfigError('MOTIR_AI_URL / MOTIR_AI_SERVICE_TOKEN are not set');
  }
}

/** The thread's turn with this id, from a session DTO. */
function turnById(session: PlanChangeSessionDto, turnId: string): PlanChangeTurnDto | null {
  return session.turns.find((t) => t.id === turnId) ?? null;
}

/** The `user` turn a job was submitted for, or null. The settle's key. */
function turnByJobId(session: PlanChangeSessionDto, jobId: string): PlanChangeTurnDto | null {
  return session.turns.find((t) => t.role === 'user' && t.jobId === jobId) ?? null;
}

/**
 * The session a CONTINUING ask write works on (MOTIR-6023; AMENDMENT 17 §2):
 * the one the client holds, else the caller's own resumable project-wide
 * session. A re-run or a settle continues a conversation, so with neither there
 * is nothing to continue.
 */
async function requireAskSession(
  ctx: ProjectContext,
  sessionId: string | undefined,
): Promise<PlanChangeSessionDto> {
  const session = sessionId
    ? await planChangeSessionsService.getById(ctx, sessionId)
    : await planChangeSessionsService.findResumable(ctx, PROJECT_SCOPE_KEY);
  if (!session) throw new PlanChangeSessionNotFoundError(ctx.projectId);
  return session;
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
    opts: { isAnswer?: boolean; sessionId?: string; seedGateId?: string; anchorKey?: string } = {},
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

    // The anchor (MOTIR-7047), resolved BEFORE anything is written: an anchor the
    // caller may not see is refused with no turn appended and no job submitted.
    const anchor = opts.anchorKey ? await resolveAnchor(opts.anchorKey, ctx) : null;

    // WHICH conversation (MOTIR-6023; AMENDMENT 17 §2–§3): the session the
    // client holds, else the caller's own resumable project-wide session. With
    // neither, THIS turn starts one — the door stays self-sufficient, and a
    // session exists from its first turn, never from a look.
    //
    // A SEEDED first turn (a pick anchored at the project, MOTIR-6435) never joins
    // the caller's resumable project conversation: it starts — or resumes — the
    // session THIS gate seeded, under the seed guard (`startSeededWithFirstTurn`,
    // which refuses a gate that may not seed the project scope).
    const seeded = !opts.sessionId && opts.seedGateId ? opts.seedGateId : null;
    const current = opts.sessionId
      ? await planChangeSessionsService.getById(ctx, opts.sessionId)
      : seeded
        ? null
        : await planChangeSessionsService.findResumable(ctx, PROJECT_SCOPE_KEY);
    if (!current) {
      const started = seeded
        ? await planChangeSessionsService.startSeededWithFirstTurn(
            ctx,
            PROJECT_SCOPE,
            trimmed,
            seeded,
            { isAnswer: opts.isAnswer === true },
          )
        : await planChangeSessionsService.startWithFirstTurn(ctx, PROJECT_SCOPE, trimmed, {
            isAnswer: opts.isAnswer === true,
          });
      const first = started.turns.at(-1);
      if (!first) throw new PlanChangeTurnNotFoundError('(the turn just appended)');
      // A fresh session has no pending question, so this is the ask branch.
      const { jobId } = await submitAsk(trimmed, anchor, ctx);
      const session = await planChangeSessionsService.recordTurnIntent(
        first.id,
        'ask',
        ctx,
        { jobId },
        { sessionId: started.id },
      );
      return { jobId, turnId: first.id, session };
    }
    const address = { sessionId: current.id };

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
      await planChangeSessionsService.appendTurn(trimmed, ctx, address, {
        // What actually RAN. The field records the effective disposition, and
        // what runs on this branch is the plan-change submit, not an ask.
        intent: 'plan_change',
        isAnswer: true,
      });
      // The SHIPPED submit, untouched: it accumulates every user turn in order,
      // which is how answering RESUMES the run rather than restarting it.
      const submitted = await planChangeSessionsService.submit(ctx, address);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    const appended = await planChangeSessionsService.appendTurn(trimmed, ctx, address, {
      intent: 'ask',
      // Recorded even here: a turn sent from the answer bar when nothing was
      // pending is still a fact about the affordance, and the transcript keeps
      // facts rather than tidying them away.
      isAnswer: opts.isAnswer === true,
    });
    const turn = appended.turns.at(-1);
    if (!turn) throw new PlanChangeTurnNotFoundError('(the turn just appended)');

    const { jobId } = await submitAsk(trimmed, anchor, ctx);
    const session = await planChangeSessionsService.recordTurnIntent(
      turn.id,
      'ask',
      ctx,
      { jobId },
      address,
    );
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
    opts: { flip?: boolean; sessionId?: string; anchorKey?: string } = {},
  ): Promise<AskSubmitResult | AskRedirectResult | AskDebugResult> {
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );

    const current = await requireAskSession(ctx, opts.sessionId);
    const address = { sessionId: current.id };
    const turn = turnById(current, turnId);
    if (!turn || turn.role !== 'user') throw new PlanChangeTurnNotFoundError(turnId);

    // The flip stays a TWO-WAY switch between the pair §3 drew: an `ask` flips to
    // `plan_change`, and anything else — `plan_change` or `debug` — flips to
    // `ask` (A1.5: a debug mis-read is corrected by answering instead; its write,
    // if any, stays). A flip INTO `debug` is not offered here: the classifier is
    // the only thing that reads a turn as a report.
    const ran = turn.intent ?? 'ask';
    const next = opts.flip ? (ran === 'ask' ? 'plan_change' : 'ask') : ran;
    const anchor = opts.anchorKey ? await resolveAnchor(opts.anchorKey, ctx) : null;

    if (next === 'debug') {
      // The RETRY of a debug turn — its dispatch failed after the turn was
      // recorded as `debug` (the settle arm moves the intent first). Re-run the
      // SAME diagnosis; the classifier is not asked again.
      await assertCanDebug(ctx);
      const { jobId } = await submitConversationJob('debug_bug', turn.body, anchor, ctx);
      const session = await planChangeSessionsService.recordTurnIntent(
        turnId,
        'debug',
        ctx,
        { jobId },
        address,
      );
      return { outcome: 'debugging', jobId, session };
    }

    if (next === 'plan_change') {
      // Hand it to the SHIPPED plan-change submit. Untouched: it accumulates the
      // thread's user turns exactly as it always has.
      await planChangeSessionsService.recordTurnIntent(
        turnId,
        'plan_change',
        ctx,
        { corrected: opts.flip === true },
        address,
      );
      const submitted = await planChangeSessionsService.submit(ctx, address);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    const { jobId } = await submitAsk(turn.body, anchor, ctx);
    const session = await planChangeSessionsService.recordTurnIntent(
      turnId,
      'ask',
      ctx,
      { corrected: opts.flip === true, jobId },
      address,
    );
    return { jobId, turnId, session };
  },

  /**
   * Read a settled `ask_project` job and file what it produced.
   *
   * REPLAYABLE: the answer append is idempotent on the job id, and the redirect
   * arm is guarded by the turn's current intent, so a second settle of the same
   * job neither duplicates a bubble nor dispatches a second plan-edit job.
   *
   * The DEBUG arm (MOTIR-7047) is guarded harder, because it is the arm that
   * would otherwise write twice: the turn's intent moves `ask → debug` under the
   * session's row lock (`claimTurnIntent`) BEFORE the `debug_bug` job is
   * submitted, so of two concurrent settles exactly one submits. The gates
   * ({@link assertCanDebug}) and the anchor's re-resolution run before that claim,
   * so a refusal leaves the turn an `ask` and submits nothing. A submit that fails
   * AFTER the claim leaves the turn `debug` with no debug job — the rail's error
   * state, and `resubmit` re-runs the diagnosis without asking the classifier
   * again.
   */
  async settle(
    jobId: string,
    ctx: ProjectContext,
    opts: { sessionId?: string } = {},
  ): Promise<AskSettleResult> {
    const session = await requireAskSession(ctx, opts.sessionId);
    const address = { sessionId: session.id };
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
      await planChangeSessionsService.recordTurnIntent(turn.id, 'plan_change', ctx, {}, address);
      const submitted = await planChangeSessionsService.submit(ctx, address);
      return {
        outcome: 'redirected',
        jobId: submitted.jobId,
        planId: submitted.planId,
        session: submitted.session,
      };
    }

    if (outcome.intent === 'debug') {
      // Already dispatched by an earlier settle of this same job (the turn's
      // `jobId` has usually moved to the debug job too, so a replay rarely even
      // gets here) — never a second debug job for one turn.
      if (turn.intent === 'debug') return { outcome: 'silent', session };
      await assertCanDebug(ctx);
      // The echo is a CLAIM from across the boundary; re-resolve it under THIS
      // caller's access rather than forwarding whatever came back.
      const anchor = outcome.anchorKey ? await resolveAnchor(outcome.anchorKey, ctx) : null;
      const claimed = await planChangeSessionsService.claimTurnIntent(
        turn.id,
        { from: 'ask', to: 'debug' },
        ctx,
        address,
      );
      if (!claimed) return { outcome: 'silent', session };
      const { jobId: debugJobId } = await submitConversationJob(
        'debug_bug',
        turn.body,
        anchor,
        ctx,
      );
      const updated = await planChangeSessionsService.recordTurnIntent(
        turn.id,
        'debug',
        ctx,
        { jobId: debugJobId },
        address,
      );
      return { outcome: 'debugging', jobId: debugJobId, session: updated };
    }

    if (!outcome.answer) return { outcome: 'silent', session };

    const updated = await planChangeSessionsService.appendAnswerTurn(
      { jobId, body: outcome.answer, citations: outcome.citations },
      ctx,
      address,
    );
    return { outcome: 'answered', session: updated };
  },

  /** The live channel the rail subscribes to — the shipped job stream, relayed. */
  streamAsk(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
    return streamJob(jobId, coreProjectId);
  },
};
