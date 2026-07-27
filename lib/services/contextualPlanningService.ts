import type { JobStreamEvent } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { buildScope, MAX_SCOPE_TARGETS, type PlanChangeScope } from '@/lib/planChange/scope';
import { TooManyPlanChangeTargetsError } from '@/lib/planChange/errors';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// CONTEXTUAL PLANNING — the motir-core side (7.12.3 · MOTIR-909).
//
// "Plan / Re-plan from this work item": a planning conversation ANCHORED at one
// or more work items, whose turns become the SHIPPED 7.11 plan-edit job scoped to
// those anchors' neighborhood (7.12.2 · MOTIR-908), streamed back to the embedded
// panel. Three things it deliberately is NOT:
//
//  * NOT a new chat stack. The thread IS the shipped plan-change conversation
//    (Story 7.30), addressed by its anchor set instead of by the project alone —
//    same table, same turn allocation, same accumulated-intent submit. All AI
//    conversation rides one substrate.
//  * NOT a new job kind. `submitContextual` sends an ordinary 7.11 job with
//    `context.targetKeys`; motir-ai resolves which of expand/augment/replan the
//    turn is. Core does not pre-classify — two classifiers in one loop is how the
//    engine's judgement gets overridden by a caller's guess.
//  * NOT a write to the plan. This opens the session, submits, and streams. The
//    proposed delta is PERSISTED only through the confirmation gate (7.13.5) on
//    the shipped approve route — nothing here touches a work item.
//
// SCOPED, NOT FENCED. The turn is anchored at the targets, but the delta motir-ai
// proposes may touch an anchor, a sibling, or a parent. This service passes the
// anchors as the scope and lets the job reach the neighborhood; it does not
// pre-restrict what the proposal may target. What it DOES enforce is the 6.4 view
// gate on EVERY anchor — `workItemsService` resolves each one as the requesting
// user, so an item in another tenant, or one this actor cannot browse, 404s here
// instead of silently becoming planning context. (Editability of the wider
// neighborhood a parent re-plan would touch is re-checked at persist, where the
// write actually happens.)
//
// 4-layer (CLAUDE.md): the routes parse and call ONE method; this service owns the
// orchestration and composes other services; it opens no transaction of its own
// (the turn appends own theirs, inside `planChangeSessionsService`) and touches no
// repository or Prisma client directly.

export interface ContextualPlanRequest {
  /** The work item the panel is open on — the PRIMARY anchor, by database id
   *  (the `/api/work-items/[id]` path form every sibling route uses). */
  anchorId: string;
  /** ADDITIONAL anchors, by work-item identifier ("MOTIR-812") — what the
   *  @-mention target picker inserts. Empty for the single-target entrance, which
   *  is simply the 1-element case. */
  targetKeys?: readonly string[];
  /** The turn the user typed. For a Re-plan this IS the "reason" — the contract
   *  carries no separate reason field, by design (7.12.2). */
  prompt: string;
}

export interface ContextualPlanResult {
  jobId: string;
  sessionId: string;
  session: PlanChangeSessionDto;
}

/**
 * Resolve + VIEW-GATE every anchor, and return the canonical scope.
 *
 * Each anchor goes through `workItemsService`, which is the 6.4 permission
 * authority: it rejects a cross-tenant row as `WorkItemNotFoundError` (404, no
 * existence leak) and a non-browsable project as `ProjectAccessDeniedError`
 * ('browse' → also 404). The primary anchor additionally has to live in the
 * project the turn plans against — an anchor from a sibling project would silently
 * plan against the wrong tree, so it is treated as absent rather than adopted.
 */
async function resolveScope(
  req: ContextualPlanRequest,
  pctx: ProjectContext,
): Promise<PlanChangeScope> {
  const extra = req.targetKeys ?? [];
  // Bound BEFORE the round-trips: the cost of a huge set is the resolution
  // fan-out itself, so rejecting after resolving them would be too late.
  if (extra.length + 1 > MAX_SCOPE_TARGETS) {
    throw new TooManyPlanChangeTargetsError(extra.length + 1, MAX_SCOPE_TARGETS);
  }

  const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
  const anchor = await workItemsService.getWorkItem(req.anchorId, ctx);
  if (anchor.projectId !== pctx.projectId) throw new WorkItemNotFoundError(req.anchorId);

  const identifiers = [anchor.identifier];
  for (const key of extra) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    const item = await workItemsService.getWorkItemByIdentifier(pctx.projectId, trimmed, ctx);
    identifiers.push(item.identifier);
  }
  return buildScope(identifiers);
}

export const contextualPlanningService = {
  /**
   * Open (or RESUME) the planning conversation anchored at the target set, append
   * the user's turn, and submit it as the scoped 7.11 job.
   *
   * Resume matters: the scope key is canonical, so re-opening the panel on the
   * same items — in any order, from any of them — continues the SAME thread, and
   * the accumulated intent of the whole conversation is what the engine receives.
   *
   * Returns the job to stream, the session id, and the thread as it now stands
   * (its user turn and its submission marker included), so the panel renders from
   * one response instead of re-reading.
   */
  async planFromWorkItem(
    req: ContextualPlanRequest,
    pctx: ProjectContext,
  ): Promise<ContextualPlanResult> {
    const scope = await resolveScope(req, pctx);

    // Get-or-create is idempotent per scope; appendTurn validates non-empty and
    // allocates `seq` under the session row's lock; submit sends the ACCUMULATED
    // intent with the anchor set attached (the thread's own `targetKeys` are what
    // make the submit contextual — this service does not pass them twice).
    await planChangeSessionsService.getOrCreateForScope(pctx, scope);
    await planChangeSessionsService.appendTurn(req.prompt, pctx, scope.scopeKey);
    const { jobId, session } = await planChangeSessionsService.submit(pctx, scope.scopeKey);

    return { jobId, sessionId: session.id, session };
  },

  /**
   * RESUME the item's thread — the entrance's mount read (MOTIR-910), so
   * re-opening the workspace on an item shows the conversation already had
   * rather than a blank rail that only fills in after the next turn.
   *
   * Read-only by construction: it resolves + view-gates the anchor set exactly as
   * a turn does, then READS the thread for that scope. An item never planned
   * before has no thread — `null`, not a freshly written empty row (opening a
   * door is not starting a conversation).
   */
  async getSessionForWorkItem(
    req: Omit<ContextualPlanRequest, 'prompt'>,
    pctx: ProjectContext,
  ): Promise<{ session: PlanChangeSessionDto | null }> {
    const scope = await resolveScope({ ...req, prompt: '' }, pctx);
    const session = await planChangeSessionsService.findForScope(pctx, scope);
    return { session };
  },

  /**
   * RE-SUBMIT the thread's accumulated intent WITHOUT appending a turn — the
   * rail's Retry after a failed run (MOTIR-910).
   *
   * Retry must not append: the design's error state is "recoverable in place —
   * the thread survives", so re-sending the same accumulated intent is the
   * correct repair. Appending the last turn again would instead change what the
   * engine is asked, and duplicate the user's words in their own transcript.
   * A scope with no thread yet has nothing to resubmit (`PlanChangeSessionNotFoundError`
   * from the shared submit path).
   */
  async resubmitFromWorkItem(
    req: Omit<ContextualPlanRequest, 'prompt'>,
    pctx: ProjectContext,
  ): Promise<ContextualPlanResult> {
    const scope = await resolveScope({ ...req, prompt: '' }, pctx);
    const { jobId, session } = await planChangeSessionsService.submit(pctx, scope.scopeKey);
    return { jobId, sessionId: session.id, session };
  },

  /**
   * The live channel for a submitted turn: relay the motir-ai job stream to the
   * browser. The anchor is re-gated on every subscribe (the stream route is a
   * separate request — a permission that held at submit is not evidence it still
   * holds now), and the browser reaches motir-ai ONLY through here: the client is
   * `server-only`, so the open-core invariant is structural, not a convention.
   *
   * Returns the generator rather than consuming it, so the ROUTE owns the iterator
   * and client disconnect cancels it promptly (the shipped stream-route shape).
   */
  async streamPlanJob(
    anchorId: string,
    jobId: string,
    pctx: ProjectContext,
  ): Promise<AsyncGenerator<JobStreamEvent>> {
    const ctx: ServiceContext = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    const anchor = await workItemsService.getWorkItem(anchorId, ctx);
    if (anchor.projectId !== pctx.projectId) throw new WorkItemNotFoundError(anchorId);
    return aiPlanEditsService.streamContextual(jobId);
  },
};
