import type { ProjectContext } from '@/lib/projects';
import { describedForWrite, type AuthoredBug } from '@/lib/ai/authoredBug';
import { parseDebugBug, type DebugBugOutcome } from '@/lib/ai/debugBug';
import type { DebugLandingDto, PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { UpdateWorkItemInput, WorkItemDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { commentsService } from '@/lib/services/commentsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { triageService } from '@/lib/services/triageService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanChangeSessionAddress } from '@/lib/services/planChangeSessionsService';
import { readWorkItem } from '@/lib/workspaces/tenantRead';
import { CommentForbiddenError } from '@/lib/comments/errors';
import {
  DebugAnchorNotTriageBugError,
  DebugTargetChangedError,
  DebugTargetNotAvailableError,
} from '@/lib/planChange/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  InvalidTriageSubmissionKindError,
  InvalidTriageSubmissionTitleError,
} from '@/lib/triage/errors';
import { readCodeUnreadable } from '@/lib/planning/codeUnreadable';
import { StaleWorkItemError, WorkItemError, WorkItemNotFoundError } from '@/lib/workItems/errors';

// LANDING a debug turn (Story MOTIR-7042 · MOTIR-7049) — the write half of the
// conversation's THIRD intent, `docs/decisions/conversation-turn-intent.md`
// AMENDMENT 1 · A1.4. `debug_bug` (motir-ai, MOTIR-7046) diagnoses and writes
// nothing; this reads its settled result and makes the ONE write the turn is
// allowed:
//
//   | result                                 | the one write                                   |
//   | -------------------------------------- | ----------------------------------------------- |
//   | `enrich_existing`                      | ONE comment on the named card, carrying the     |
//   |                                        | diagnosis; its `motir:` reference to the anchor |
//   |                                        | relates the two in the same transaction         |
//   | `diagnose`, anchored on a triage bug   | ONE update of that bug, ADDING the diagnosis    |
//   | `diagnose`, no anchor (the orb)        | ONE bug created in Triage, born with it         |
//   | `grounded: false` (either outcome)     | NOTHING — the turn says it could not ground it  |
//
// ── ONE CARD, ONE TRANSACTION ────────────────────────────────────────────────
// Each row's write is ONE call into the authority that already owns it, and each
// of those is one transaction: `commentsService.addComment` (the comment + its
// auto-relate link), `workItemsService.updateWorkItem`, and
// `triageService.createSubmission` — which now carries the diagnosis's planned
// fields INTO the create, so the orb's bug is never visible half-written. Every
// write runs as the SENDER through the gated path, so the turn can do nothing
// they could not do by hand. Nothing here moves a status, kind, parent, sprint
// or dependency edge, and nothing promotes a triage item.
//
// ── EXACTLY ONCE: A CLAIM BEFORE THE WRITE ───────────────────────────────────
// The settle is replayable (a reload, a retried request, a second tab), and the
// write lives in another service's transaction, so it cannot share one with the
// thread. The turn therefore carries a CLAIM (`debugLandingClaimedAt`), taken by
// a compare-and-set under the session's row lock AFTER every check has passed
// and BEFORE the write:
//
//   * a replay after a finished landing finds the job's `assistant` turn and
//     returns the same DTO, writing nothing;
//   * a concurrent settle loses the claim and writes nothing;
//   * a write REFUSED inside its own transaction (a stale edit, a permission)
//     committed nothing, so the claim is released and a later settle retries;
//   * any OTHER failure after the claim keeps it — the landing fails CLOSED. A
//     crash between the write and the reply leaves the card written and the
//     turn without its reply; it never files a second bug.

/** The line an ungrounded turn answers with. motir-ai's own `replyMd` names where
 *  the diagnosis "goes", which is untrue once A1.4's no-write row applies, so
 *  core states what it actually did. */
export const DEBUG_UNGROUNDED_REPLY =
  "I could not ground this report in the project's code, so I did not write it onto any card. Add where it happens, or what you were doing when it broke, and send it again.";

/** The line an anchored bug's diagnosis sits under — everything above it is the
 *  report as the person filed it (A1.4: ADD, never replace). */
export const DEBUG_DIAGNOSIS_DIVIDER =
  '_Diagnosis added by Motir AI. Everything above the line is the report as it was filed._';

/** What {@link debugLandingService.land} did. `null` from `land` means another
 *  settle of the same job holds the claim and has not replied yet. */
export interface DebugLandingResult {
  landing: DebugLandingDto;
  session: PlanChangeSessionDto;
}

/** The one card a checked result will write to — resolved BEFORE the claim. */
type Target =
  | { kind: 'comment'; card: WorkItemDto; anchor: WorkItemDto | null }
  | { kind: 'update'; bug: WorkItemDto }
  | { kind: 'create' };

function actorOf(ctx: ProjectContext): ServiceContext {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

/** Resolve a key the result names, in the ACTIVE project, under the sender's
 *  access — every "not for you" is the one no-leak 404. */
async function resolveKey(key: string, ctx: ProjectContext): Promise<WorkItemDto> {
  try {
    return await workItemsService.getWorkItemByIdentifier(ctx.projectId, key, actorOf(ctx));
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      throw new DebugTargetNotAvailableError();
    }
    throw err;
  }
}

/** Every check, and no write. What it throws leaves the thread and every card
 *  exactly as they stood. */
async function resolveTarget(result: DebugBugOutcome, ctx: ProjectContext): Promise<Target> {
  // A1.4: every write runs as the sender under their own permissions. The same
  // key the debug dispatch asserted — re-asserted, because a role can change
  // while the diagnosis runs.
  await projectAccessService.assertPermission(ctx.projectId, actorOf(ctx), 'work_item:edit');

  if (result.outcome === 'enrich_existing') {
    const card = await resolveKey(result.workItemKey, ctx);
    const anchor = result.anchorKey ? await resolveKey(result.anchorKey, ctx) : null;
    return { kind: 'comment', card, anchor };
  }
  if (!result.anchorKey) return { kind: 'create' };

  const bug = await resolveKey(result.anchorKey, ctx);
  // The DTO carries no triage marker; the tenant read does (the same row, under
  // the same workspace binding the keyed read just used).
  const row = await readWorkItem(bug.id, actorOf(ctx));
  if (!row || row.kind !== 'bug' || row.triagedAt === null) {
    throw new DebugAnchorNotTriageBugError(result.anchorKey);
  }
  return { kind: 'update', bug };
}

/** The enrichment comment: the diagnosis, and — when the turn was anchored — a
 *  `motir:` reference to the anchor, which `addComment`'s auto-relate turns into
 *  the `relates_to` link inside the comment's own transaction (ADD-only: a pair
 *  already linked in any kind is left untouched). */
function enrichmentComment(
  result: Extract<DebugBugOutcome, { outcome: 'enrich_existing' }>,
  anchor: WorkItemDto | null,
): string {
  const lead = anchor
    ? `**Motir AI diagnosis.** This card already covers the defect reported as [${anchor.identifier}](motir:${anchor.id}).`
    : '**Motir AI diagnosis.** This card already covers a defect reported in the conversation.';
  return [
    lead,
    ...(result.matchReason ? ['', `> ${result.matchReason.replace(/\s*\n+\s*/g, ' ')}`] : []),
    '',
    describedForWrite(result.diagnosis),
    '',
    '**Why it matters**',
    '',
    result.diagnosis.explanationMd,
  ].join('\n');
}

/**
 * The patch that ADDS a diagnosis to a triage bug without replacing anything the
 * person wrote (A1.4). Their description stays, word for word, ABOVE a rule and
 * the diagnosis goes beneath it; the title is never touched; every planned field
 * (explanation, type, executor, sizing, difficulty) is written only where the
 * card has none, so a value a person set survives.
 */
function additivePatch(bug: WorkItemDto, diagnosis: AuthoredBug): UpdateWorkItemInput {
  const own = bug.descriptionMd?.trim() ?? '';
  const block = `${DEBUG_DIAGNOSIS_DIVIDER}\n\n${describedForWrite(diagnosis)}`;
  const patch: UpdateWorkItemInput = {
    descriptionMd: own ? `${own}\n\n---\n\n${block}` : block,
  };
  if (!bug.explanationMd?.trim()) {
    patch.explanationMd = diagnosis.explanationMd;
    patch.explanationSource = 'ai_draft';
  }
  if (bug.type === null) patch.type = diagnosis.type;
  if (bug.executor === null) patch.executor = diagnosis.executor;
  if (bug.storyPoints === null) patch.storyPoints = diagnosis.storyPoints;
  if (bug.estimateMinutes === null) patch.estimateMinutes = diagnosis.estimateMinutes;
  if (bug.difficulty === null && diagnosis.difficulty !== null) {
    patch.difficulty = diagnosis.difficulty;
  }
  return patch;
}

/** A refusal raised INSIDE the write's own transaction — nothing committed, so
 *  the claim may be released. Anything else keeps it (fail closed). */
function refusedBeforeCommit(err: unknown): boolean {
  return (
    err instanceof WorkItemError ||
    err instanceof DebugTargetChangedError ||
    err instanceof CommentForbiddenError ||
    err instanceof PermissionDeniedError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof ProjectNotFoundError ||
    err instanceof InvalidTriageSubmissionKindError ||
    err instanceof InvalidTriageSubmissionTitleError
  );
}

/** Make the ONE write. Returns the card it touched. */
async function write(
  target: Target,
  result: DebugBugOutcome,
  ctx: ProjectContext,
): Promise<{ identifier: string; title: string }> {
  const actor = actorOf(ctx);
  if (target.kind === 'comment' && result.outcome === 'enrich_existing') {
    await commentsService.addComment(
      target.card.id,
      { bodyMd: enrichmentComment(result, target.anchor) },
      actor,
    );
    return { identifier: target.card.identifier, title: target.card.title };
  }
  if (target.kind === 'update') {
    try {
      const updated = await workItemsService.updateWorkItem(
        target.bug.id,
        additivePatch(target.bug, result.diagnosis),
        actor,
        // An edit landing between the read and this write is refused, never
        // overwritten — the monitor enrichment's guard.
        { expectedUpdatedAt: target.bug.updatedAt },
      );
      return { identifier: updated.identifier, title: updated.title };
    } catch (err) {
      if (err instanceof StaleWorkItemError) {
        throw new DebugTargetChangedError(target.bug.identifier);
      }
      throw err;
    }
  }
  // The orb: ONE bug, born in Triage through the intake the widget uses, WITH the
  // diagnosis — so there is no second step that could leave it half-written.
  const { diagnosis } = result;
  const created = await triageService.createSubmission(
    {
      projectKey: ctx.project.identifier,
      kind: 'bug',
      title: result.title,
      descriptionMd: describedForWrite(diagnosis),
      diagnosis: {
        explanationMd: diagnosis.explanationMd,
        type: diagnosis.type,
        executor: diagnosis.executor,
        storyPoints: diagnosis.storyPoints,
        estimateMinutes: diagnosis.estimateMinutes,
        difficulty: diagnosis.difficulty,
      },
    },
    actor,
  );
  return { identifier: created.identifier, title: created.title };
}

function landingOf(
  result: DebugBugOutcome,
  card: { identifier: string; title: string | null } | null,
): DebugLandingDto {
  if (!result.diagnosis.grounded) {
    return { outcome: 'ungrounded', workItemKey: null, title: null, createdInTriage: false };
  }
  return {
    outcome: result.outcome,
    workItemKey: card?.identifier ?? null,
    title: card?.title ?? null,
    createdInTriage: result.outcome === 'diagnose' && result.anchorKey === null,
  };
}

/** The DTO a REPLAY returns — the same one the landing returned, re-derived from
 *  the job's (immutable) result and the reply turn's citation, writing nothing. */
async function replayed(
  result: DebugBugOutcome,
  citations: readonly string[],
  ctx: ProjectContext,
): Promise<DebugLandingDto> {
  const key = citations[0];
  if (!result.diagnosis.grounded || !key) return landingOf(result, null);
  let title: string | null = null;
  try {
    title = (await resolveKey(key, ctx)).title;
  } catch (err) {
    if (!(err instanceof DebugTargetNotAvailableError)) throw err;
  }
  return landingOf(result, { identifier: key, title });
}

/** The `assistant` turn a job already produced on this thread, if any. */
function replyFor(session: PlanChangeSessionDto, jobId: string) {
  return session.turns.find((t) => t.role === 'assistant' && t.jobId === jobId) ?? null;
}

export const debugLandingService = {
  /**
   * Land a settled `debug_bug` job's result for the `user` turn it ran for.
   *
   * `result` is the job's raw result envelope, as `getJob` returned it; its
   * `debugBug` unit is parsed here and a malformed one is refused with the typed
   * `InvalidAuthoredBugError` before anything is written. Then, in order: a
   * replay returns the DTO it already returned; an ungrounded result writes no
   * card and replies that it could not ground the report; otherwise every check
   * runs ({@link resolveTarget}), the turn is claimed, the ONE write is made, and
   * the handler's `replyMd` is appended as the `assistant` turn citing the card
   * it touched — idempotent on the job id, like every settled answer.
   *
   * Returns `null` when a concurrent settle of the same job holds the claim and
   * has not replied yet: this call wrote nothing and has nothing to report.
   */
  async land(
    input: { jobId: string; turnId: string; result: unknown },
    ctx: ProjectContext,
    address: PlanChangeSessionAddress,
  ): Promise<DebugLandingResult | null> {
    const envelope = input.result as { debugBug?: unknown } | null | undefined;
    const result = parseDebugBug(envelope?.debugBug);

    const current = await planChangeSessionsService.getById(ctx, address.sessionId);
    const earlier = replyFor(current, input.jobId);
    if (earlier) {
      return { landing: await replayed(result, earlier.citations, ctx), session: current };
    }

    // A1.4's fourth row: a report that cannot be grounded writes NOTHING.
    if (!result.diagnosis.grounded) {
      const landing = landingOf(result, null);
      const session = await planChangeSessionsService.appendAnswerTurn(
        {
          jobId: input.jobId,
          body: DEBUG_UNGROUNDED_REPLY,
          citations: [],
          debugLanding: landing,
          // A report that could not be grounded BECAUSE the code could not be read
          // carries the outage notice with its reply (MOTIR-8141).
          codeUnreadable: readCodeUnreadable(input.result) === 'answered' ? 'answered' : null,
        },
        ctx,
        address,
      );
      return { landing, session };
    }

    const target = await resolveTarget(result, ctx);

    const claimed = await planChangeSessionsService.claimDebugLanding(input.turnId, ctx, address);
    if (!claimed) {
      const latest = await planChangeSessionsService.getById(ctx, address.sessionId);
      const reply = replyFor(latest, input.jobId);
      if (!reply) return null;
      return { landing: await replayed(result, reply.citations, ctx), session: latest };
    }

    let card: { identifier: string; title: string };
    try {
      card = await write(target, result, ctx);
    } catch (err) {
      if (refusedBeforeCommit(err)) {
        await planChangeSessionsService.releaseDebugLanding(input.turnId, ctx, address);
      }
      throw err;
    }

    // The landing rides ON the reply (MOTIR-7064): one append writes both, so the
    // outcome line a reload draws is the one the settle returned.
    const landing = landingOf(result, card);
    const session = await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: input.jobId,
        body: result.replyMd,
        citations: [card.identifier],
        debugLanding: landing,
      },
      ctx,
      address,
    );
    return { landing, session };
  },
};
