import type { ProjectContext } from '@/lib/projects';
import { describedForWrite, type AuthoredBug } from '@/lib/ai/authoredBug';
import type { DebugBugOutcome } from '@/lib/ai/debugBug';
import { motirSystemContext } from '@/lib/ai/serviceAuth';
import type {
  DebugLandingDto,
  LogBugOfferDto,
  PlanChangeSessionDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';
import type { UpdateWorkItemInput, WorkItemDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { commentsService } from '@/lib/services/commentsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { readWorkItem } from '@/lib/workspaces/tenantRead';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { CommentForbiddenError } from '@/lib/comments/errors';
import {
  DebugAnchorNotTriageBugError,
  DebugTargetChangedError,
  DebugTargetNotAvailableError,
  PlanChangeTurnNotFoundError,
  PlanOfferStartRefusedError,
} from '@/lib/planChange/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { StaleWorkItemError, WorkItemError, WorkItemNotFoundError } from '@/lib/workItems/errors';

// LANDING a confirmed `log_bug` offer (Story MOTIR-9220 · MOTIR-9323; first shipped
// for the debug turn, MOTIR-7042 · MOTIR-7049, `docs/decisions/conversation-turn-
// intent.md` AMENDMENT 1 · A1.4). An answer that found a defect carries ONE stored
// offer (`logBugOfferService.land`, MOTIR-9322); the person's yes — the Confirm press
// or a typed agreement — reaches {@link debugLandingService.confirmLogBugOffer}, which
// makes the ONE write the offer names:
//
//   | the offer's target | the one write                                          |
//   | ------------------ | ------------------------------------------------------ |
//   | `existing`         | ONE comment on the covering card, carrying the         |
//   |                    | diagnosis; its `motir:` reference to the anchor        |
//   |                    | relates the two in the same transaction                |
//   | `anchored`         | ONE update of the anchored triage bug, ADDING the      |
//   |                    | diagnosis                                              |
//   | `new`              | ONE bug created in the project's bug destination,      |
//   |                    | born with the diagnosis                                |
//
// No model call and no code read happens here: the draft and its context refs are
// written exactly as the settle checked and stored them.
//
// ── READ AS THE PERSON, WRITTEN BY MOTIR ─────────────────────────────────────
// The target is re-resolved under the SENDER'S read access, so Motir never writes to
// a card the person cannot see. The write itself is Motir's (MOTIR-9329): it runs
// under the system account's context bound to this workspace, so a new bug's
// reporter is Motir, the anchored bug's revision and the covering card's comment are
// Motir's, and the person's own `work_item:edit` is never asked for. Each write is
// ONE call into the authority that already owns it, and each of those is one
// transaction: `commentsService.addComment` (the comment + its auto-relate link),
// `workItemsService.updateWorkItem`, and `workItemsService.createWorkItem` — placed
// the way `aiWorkItemsService.fileBug` places Motir's bugs, never through Triage.
// Nothing here moves a status, kind, parent, sprint or dependency edge.
//
// ── A STALE TARGET IS REFUSED ────────────────────────────────────────────────
// The offer stored its target's `updatedAt` when the answer settled. A target edited
// since — the anchored bug, or the covering card — is refused with
// `DebugTargetChangedError` rather than written over: a read taken at confirm cannot
// see an edit made between the offer and the press.
//
// ── EXACTLY ONCE: A CLAIM BEFORE THE WRITE ───────────────────────────────────
// The write lives in another service's transaction, so it cannot share one with the
// thread. The OFFER'S turn therefore carries a CLAIM (`debugLandingClaimedAt`), taken
// by a compare-and-set under the session's row lock AFTER every check has passed and
// BEFORE the write:
//
//   * a confirm after a finished landing finds `debugLanding` on the offer's turn and
//     returns it, writing nothing;
//   * a concurrent confirm (a double press, a second tab, Confirm plus a typed yes)
//     loses the claim, writes nothing, and answers the winner's landing;
//   * a write REFUSED inside its own transaction (a stale edit, a permission)
//     committed nothing, so the claim is released and a later confirm retries;
//   * any OTHER failure after the claim keeps it — the landing fails CLOSED. A crash
//     between the write and the stamp leaves the card written and the offer
//     unstamped; it never files a second bug.

/** The line an anchored bug's diagnosis sits under — everything above it is the
 *  report as the person filed it (A1.4: ADD, never replace). */
export const DEBUG_DIAGNOSIS_DIVIDER =
  '_Diagnosis added by Motir AI. Everything above the line is the report as it was filed._';

/** What {@link debugLandingService.confirmLogBugOffer} landed, and the thread after. */
export interface DebugLandingResult {
  landing: DebugLandingDto;
  session: PlanChangeSessionDto;
}

/** The one card a checked offer will write to — resolved BEFORE the claim. */
type Target =
  | { kind: 'comment'; card: WorkItemDto; anchor: WorkItemDto | null }
  | { kind: 'update'; bug: WorkItemDto }
  | { kind: 'create' };

/** How long a losing confirm waits for the winner's stamp before it gives up. */
const WINNER_WAIT_MS = 30_000;
const WINNER_POLL_MS = 200;

function actorOf(ctx: ProjectContext): ServiceContext {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

/** Resolve a key the offer names, in the ACTIVE project, under the sender's
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
 *  exactly as they stood. Read access is the SENDER'S; no edit permission of theirs
 *  is asked for, because the write is Motir's (MOTIR-9329). */
async function resolveTarget(result: DebugBugOutcome, ctx: ProjectContext): Promise<Target> {
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

/** A refusal raised INSIDE the write's own transaction, or before it — nothing
 *  committed, so the claim may be released. Anything else keeps it (fail closed). */
function refusedBeforeCommit(err: unknown): boolean {
  return (
    err instanceof WorkItemError ||
    err instanceof DebugTargetChangedError ||
    err instanceof CommentForbiddenError ||
    err instanceof PermissionDeniedError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof ProjectNotFoundError
  );
}

/**
 * Make the ONE write, as Motir (`motir`). `expectedUpdatedAt` is the target's
 * `updatedAt` the offer stored when it settled: a target edited since is refused,
 * never written over. Returns the card it touched.
 */
async function write(
  target: Target,
  result: DebugBugOutcome,
  expectedUpdatedAt: string | null,
  ctx: ProjectContext,
  motir: ServiceContext,
): Promise<{ identifier: string; title: string }> {
  if (target.kind === 'comment' && result.outcome === 'enrich_existing') {
    // A comment has no stale guard of its own, so the stored stamp is compared here.
    if (expectedUpdatedAt !== null && target.card.updatedAt !== expectedUpdatedAt) {
      throw new DebugTargetChangedError(target.card.identifier);
    }
    await commentsService.addComment(
      target.card.id,
      { bodyMd: enrichmentComment(result, target.anchor) },
      motir,
    );
    return { identifier: target.card.identifier, title: target.card.title };
  }
  if (target.kind === 'update') {
    try {
      const updated = await workItemsService.updateWorkItem(
        target.bug.id,
        additivePatch(target.bug, result.diagnosis),
        motir,
        // An edit landing since the offer is refused, never overwritten — the
        // monitor enrichment's guard, fed the offer's own stamp.
        { expectedUpdatedAt: expectedUpdatedAt ?? target.bug.updatedAt },
      );
      return { identifier: updated.identifier, title: updated.title };
    } catch (err) {
      if (err instanceof StaleWorkItemError) {
        throw new DebugTargetChangedError(target.bug.identifier);
      }
      throw err;
    }
  }
  // A NEW bug: ONE create, by Motir, in the project's bug destination — the place
  // `aiWorkItemsService.fileBug` files Motir's bugs — WITH the diagnosis, so there
  // is no second step that could leave it half-written. Never through Triage.
  const { diagnosis } = result;
  const { folderId } = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    bugDestinationService.resolve(ctx.projectId, tx),
  );
  const created = await workItemsService.createWorkItem(
    {
      projectId: ctx.projectId,
      kind: 'bug',
      title: result.title,
      parentId: null,
      folderId,
      descriptionMd: describedForWrite(diagnosis),
      explanationMd: diagnosis.explanationMd,
      explanationSource: 'ai_draft',
      type: diagnosis.type,
      executor: diagnosis.executor,
      storyPoints: diagnosis.storyPoints,
      estimateMinutes: diagnosis.estimateMinutes,
      ...(diagnosis.difficulty !== null ? { difficulty: diagnosis.difficulty } : {}),
    },
    motir,
  );
  return { identifier: created.identifier, title: created.title };
}

function landingOf(
  result: DebugBugOutcome,
  card: { identifier: string; title: string },
): DebugLandingDto {
  return {
    outcome: result.outcome,
    workItemKey: card.identifier,
    title: card.title,
    // Motir creates its bug directly; nothing lands in Triage any more.
    createdInTriage: false,
  };
}

/**
 * The stored offer as the landing's input. The draft was checked when the answer
 * settled and the offer exists only on a grounded read, so nothing is parsed here.
 * `existing` enriches the covering card, relating it to the turn's anchor; `anchored`
 * diagnoses the anchored triage bug; `new` diagnoses into a new bug.
 */
export function outcomeOfOffer(bug: LogBugOfferDto, turnAnchorKey: string | null): DebugBugOutcome {
  const common = {
    title: bug.title,
    acceptanceCriteria: bug.acceptanceCriteria,
    diagnosis: bug.draft,
  };
  if (bug.target.kind === 'existing' && bug.target.key) {
    return {
      ...common,
      outcome: 'enrich_existing',
      workItemKey: bug.target.key,
      matchReason: null,
      anchorKey: turnAnchorKey === bug.target.key ? null : turnAnchorKey,
    };
  }
  if (bug.target.kind === 'anchored' && bug.target.key) {
    return { ...common, outcome: 'diagnose', anchorKey: bug.target.key };
  }
  return { ...common, outcome: 'diagnose', anchorKey: null };
}

/** The resolved anchor of the person's turn the offer's answer answered. */
function turnAnchorOf(session: PlanChangeSessionDto, offerTurn: PlanChangeTurnDto): string | null {
  const asked = session.turns.find((t) => t.role === 'user' && t.jobId === offerTurn.jobId);
  return asked?.anchorKey ?? null;
}

/** Whether the offer turn's claim is still held — read straight from the row,
 *  because the DTO does not carry it. */
async function claimHeld(
  ctx: ProjectContext,
  sessionId: string,
  offerTurnId: string,
): Promise<boolean> {
  const row = await withWorkspaceContext(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: ctx.projectId },
    (tx) => planChangeTurnRepository.findByIdInSession(offerTurnId, sessionId, ctx.workspaceId, tx),
  );
  return row?.debugLandingClaimedAt != null;
}

/** The losing confirm's answer: the winner's landing, waited for while the winner is
 *  still writing. Null when the winner gave its claim back (its write was refused). */
async function winnerOf(
  ctx: ProjectContext,
  sessionId: string,
  offerTurnId: string,
): Promise<DebugLandingResult | null> {
  const deadline = Date.now() + WINNER_WAIT_MS;
  for (;;) {
    const session = await planChangeSessionsService.getById(ctx, sessionId);
    const landing = session.turns.find((t) => t.id === offerTurnId)?.debugLanding;
    if (landing) return { landing, session };
    if (!(await claimHeld(ctx, sessionId, offerTurnId))) return null;
    if (Date.now() >= deadline) throw new PlanOfferStartRefusedError('offer_not_open');
    await new Promise((resolve) => setTimeout(resolve, WINNER_POLL_MS));
  }
}

async function confirm(
  ctx: ProjectContext,
  input: { conversationId: string; offerTurnId: string },
  attempts: number,
): Promise<DebugLandingResult> {
  const address = { sessionId: input.conversationId };
  const thread = await planChangeSessionsService.getById(ctx, input.conversationId);
  const offerTurn = thread.turns.find((t) => t.id === input.offerTurnId);
  const bug =
    offerTurn?.role === 'assistant' && offerTurn.offer?.kind === 'log_bug'
      ? offerTurn.offer.bug
      : undefined;
  if (!offerTurn || !bug) throw new PlanChangeTurnNotFoundError(input.offerTurnId);
  // Already landed: the same landing, nothing written.
  if (offerTurn.debugLanding) return { landing: offerTurn.debugLanding, session: thread };
  const state = offerTurn.offer?.state;
  if (state === 'declined' || state === 'superseded') {
    throw new PlanOfferStartRefusedError('offer_not_open');
  }

  const result = outcomeOfOffer(bug, turnAnchorOf(thread, offerTurn));
  const target = await resolveTarget(result, ctx);
  // Resolved before the claim, so an unprovisioned account claims nothing.
  const motir = await motirSystemContext(ctx.workspaceId);

  const claimed = await planChangeSessionsService.claimDebugLanding(
    input.offerTurnId,
    ctx,
    address,
  );
  if (!claimed) {
    const winner = await winnerOf(ctx, input.conversationId, input.offerTurnId);
    if (winner) return winner;
    if (attempts <= 1) throw new PlanOfferStartRefusedError('offer_not_open');
    return confirm(ctx, input, attempts - 1);
  }

  let card: { identifier: string; title: string };
  try {
    card = await write(target, result, bug.targetUpdatedAt, ctx, motir);
  } catch (err) {
    if (refusedBeforeCommit(err)) {
      await planChangeSessionsService.releaseDebugLanding(input.offerTurnId, ctx, address);
    }
    throw err;
  }

  // The landing rides ON the offer's own answer turn (MOTIR-7064's outcome line),
  // stamped with the offer's confirmation in one locked write.
  const landing = landingOf(result, card);
  const session = await planChangeSessionsService.recordDebugLanding(
    input.offerTurnId,
    landing,
    ctx,
    address,
  );
  return { landing, session };
}

export const debugLandingService = {
  /**
   * The Confirm press and the typed yes on a `log_bug` offer: make the ONE write the
   * offer on `offerTurnId` names, exactly once. A second door for the same offer
   * answers the first one's landing.
   *
   *  - no `ai:plan` ⇒ `PermissionDeniedError` (403), before anything is read;
   *  - an offer turn that is absent, holds no `log_bug` offer, or is another member's
   *    ⇒ `PlanChangeTurnNotFoundError` (404);
   *  - a declined or superseded offer ⇒ `PlanOfferStartRefusedError('offer_not_open')`;
   *  - a target no longer readable to the sender ⇒ `DebugTargetNotAvailableError`; an
   *    anchor that is no longer a triage bug ⇒ `DebugAnchorNotTriageBugError`; a
   *    target edited since the offer ⇒ `DebugTargetChangedError` — nothing written,
   *    the claim released.
   */
  async confirmLogBugOffer(
    ctx: ProjectContext,
    input: { conversationId: string; offerTurnId: string },
  ): Promise<DebugLandingResult> {
    await projectAccessService.assertPermission(ctx.projectId, actorOf(ctx), 'ai:plan');
    return confirm(ctx, input, 2);
  },
};
