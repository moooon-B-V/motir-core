import { createTranslator } from 'next-intl';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import type { ProjectContext } from '@/lib/projects';
import type { Locale } from '@/lib/i18n/locales';
import { getMessagesFor } from '@/lib/i18n/messages';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { workItemsService } from '@/lib/services/workItemsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { replanOwedOf } from '@/lib/approvalGates/decisionRecord';
import {
  REFUSAL_SEED_NAMESPACE,
  anchorOf,
  isPickSeedGate,
  isPlanningSeedGate,
  readChosenOption,
  refusalSeedAnchorsOnParent,
  refusalSeedComposerFor,
  seedIntentOf,
  toSeedAncestors,
  type SeedAncestor,
  type SeedTranslator,
} from '@/lib/planning/refusalSeed';
import { PlanningSeedNotFoundError } from '@/lib/planChange/errors';
import { readGuideTurnRecord, type GuideReplanOffer } from '@/lib/ai/guideWorkItem';
import { replanOfferStateOf } from '@/lib/planning/guideReplanOffer';
import { composeGuideSeedFirstTurn, isGuideSeedableState } from '@/lib/planning/guideSeed';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { PlanningGuideSeedDTO, PlanningSeedDTO } from '@/lib/dto/planningSeed';
import type { WorkItemDto } from '@/lib/dto/workItems';

// THE PLANNING SEED read (story MOTIR-6068 · MOTIR-6208, widened to a PICKED
// option by story MOTIR-6069 · MOTIR-6433; `approval-gates.md` §10f and
// `picked-option-planning.md`): addressed by the GATE ID, never by the reason's
// or the option's text in a URL. The gate
// row is read here, its work item is resolved through the SAME browse gate the
// overlay's gate read uses, and the first turn is composed from the row by the
// kind's composer (`REFUSAL_SEED_COMPOSERS`). READING NEVER WRITES: no session,
// no turn and no job is created — the seeded session is born only when the
// person sends the turn (`planChangeSessionsService.startSeededWithFirstTurn`).

/** The browse gate's refusals — each one is "nothing here for you". */
function isNotVisible(err: unknown): boolean {
  return (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof ProjectNotFoundError
  );
}

function translatorFor(locale: Locale): SeedTranslator {
  return createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: REFUSAL_SEED_NAMESPACE,
  }) as unknown as SeedTranslator;
}

/** The work item's ancestors, root → parent, with each one's status CATEGORY. */
async function ancestorsOf(workItemId: string, pctx: ProjectContext): Promise<SeedAncestor[]> {
  const [rows, statuses] = await Promise.all([
    withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      workItemRepository.findAncestors(workItemId, pctx.workspaceId, tx),
    ),
    workflowsService.listStatusesByProject(pctx.projectId, pctx.workspaceId),
  ]);
  return toSeedAncestors(rows, statuses);
}

/**
 * The seed's ANCHOR (`approval-gates.md` §10h): the card itself, or — for a kind
 * that anchors on the card's parent (a design Re-plan) — that parent. A parentless
 * (root or folder-filed) card, or a parent this viewer cannot browse in this
 * project, anchors on the card itself; the session stamp accepts either.
 */
async function anchorKeyFor(
  kind: ApprovalGateKind,
  item: WorkItemDto,
  pctx: ProjectContext,
): Promise<string> {
  if (!refusalSeedAnchorsOnParent(kind) || !item.parentId) return item.identifier;
  try {
    const parent = await workItemsService.getWorkItem(item.parentId, {
      userId: pctx.userId,
      workspaceId: pctx.workspaceId,
    });
    return parent.projectId === pctx.projectId ? parent.identifier : item.identifier;
  } catch (err) {
    if (isNotVisible(err)) return item.identifier;
    /* v8 ignore next -- a real fault, never a fallback. */
    throw err;
  }
}

/**
 * The keys of the OPEN work waiting on a card — not archived, `blocked_by` it, in
 * this project, and outside its project's `done` category (`isTerminalStatus`, the
 * predicate the design-result publish gate applies to the same edge). Read only
 * for a kind that anchors on the parent: the decision kinds name no dependents.
 */
async function waitingKeysFor(
  kind: ApprovalGateKind,
  item: WorkItemDto,
  pctx: ProjectContext,
): Promise<string[]> {
  if (!refusalSeedAnchorsOnParent(kind)) return [];
  return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
    const dependents = (await workItemLinkRepository.findDependentKeys(item.id, tx)).filter(
      (d) => d.projectId === pctx.projectId,
    );
    if (dependents.length === 0) return [];
    const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
      [pctx.projectId],
      pctx.workspaceId,
      tx,
    );
    return dependents
      .filter((d) => !isTerminalStatus(d, terminalByProject))
      .map((d) => d.identifier);
  });
}

/** What the guide-offer read learns from the turn, its session and its thread. */
interface GuideOfferFacts {
  offer: GuideReplanOffer;
  targetKey: string;
  guidedKey: string;
  state: 'undecided' | 'confirmed';
}

/**
 * The offer on `guideTurnId`, for THIS viewer, or {@link PlanningSeedNotFoundError}.
 * One refusal for: a missing or blank turn, a turn that is not an `assistant` turn,
 * a session in another workspace or project, one that is not a `guide` conversation,
 * one that is not the viewer's, no offer, an offer with no target, and an offer that
 * is declined or superseded.
 */
async function readGuideOfferFor(
  guideTurnId: string,
  pctx: ProjectContext,
): Promise<GuideOfferFacts> {
  return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
    const turn = await planChangeTurnRepository.findById(guideTurnId, pctx.workspaceId, tx);
    if (!turn || turn.role !== 'assistant') throw new PlanningSeedNotFoundError();
    const guide = await planChangeSessionRepository.findByIdInProject(
      turn.sessionId,
      pctx.projectId,
      pctx.workspaceId,
      tx,
    );
    if (!guide || guide.origin !== 'guide' || guide.createdById !== pctx.userId) {
      throw new PlanningSeedNotFoundError();
    }
    const offer = readGuideTurnRecord(turn.guideTurn)?.replanOffer;
    if (!offer || offer.targetKey === null) throw new PlanningSeedNotFoundError();
    // The guided card is the guide conversation's scope: `startGuideWithFirstTurn`
    // writes the session with `scopeKey` / `targetKeys` of the ONE card it guides
    // (`targetKeys[0]`), the same read `guideLandingService.land` makes.
    const guidedKey = guide.targetKeys[0];
    if (!guidedKey) throw new PlanningSeedNotFoundError();
    const rows = await planChangeTurnRepository.listBySessionId(guide.id, pctx.workspaceId, tx);
    const state = replanOfferStateOf(
      rows.map((t) => ({ id: t.id, role: t.role, guide: readGuideTurnRecord(t.guideTurn) })),
      turn.id,
    );
    if (!isGuideSeedableState(state)) throw new PlanningSeedNotFoundError();
    return { offer, targetKey: offer.targetKey, guidedKey, state };
  });
}

/** A card the viewer may browse, in THIS project; else {@link PlanningSeedNotFoundError}. */
async function visibleCardIn(key: string, pctx: ProjectContext): Promise<WorkItemDto> {
  try {
    const card = await workItemsService.getWorkItemByIdentifier(pctx.projectId, key, {
      userId: pctx.userId,
      workspaceId: pctx.workspaceId,
    });
    if (card.projectId !== pctx.projectId) throw new PlanningSeedNotFoundError();
    return card;
  } catch (err) {
    if (isNotVisible(err)) throw new PlanningSeedNotFoundError();
    throw err;
  }
}

/** The target must still take new work: not archived and not in the DONE category.
 *  It is NOT re-resolved forward — the landing resolved it once, and Confirm asserts
 *  the scope equals the stored target, so a different anchor would be refused there. */
async function assertOpenTarget(target: WorkItemDto, pctx: ProjectContext): Promise<void> {
  const statuses = await workflowsService.listStatusesByProject(pctx.projectId, pctx.workspaceId);
  const done = statuses.some((s) => s.key === target.status && s.category === 'done');
  if (target.archivedAt !== null || done) throw new PlanningSeedNotFoundError();
}

export const planningSeedService = {
  /**
   * The seed a decided gate offers the planning surface, for THIS viewer — a
   * refusal's re-plan, or a pick's forward plan (`intent`).
   *
   * ⚠️ ONE REFUSAL — {@link PlanningSeedNotFoundError} — for an unknown id, a
   * gate in another workspace or project (the viewer's active project is the
   * one the seeded turn will be sent in, and the seed guard refuses any other),
   * a card-less gate, a gate whose work item the viewer cannot browse, a gate
   * `isPlanningSeedGate` does not accept (an awaiting or withdrawn choice among
   * them), a chosen gate whose `chosenOption` stamp is missing or malformed, and a
   * kind with no registered composer. Nothing in the answer tells them apart.
   *
   * `seededSessionId` is the viewer's own recent session seeded by this gate
   * (`findSeededSession`), else `null`.
   */
  async getPlanningSeed(
    gateId: string,
    pctx: ProjectContext,
    locale: Locale,
  ): Promise<PlanningSeedDTO> {
    const id = gateId.trim();
    if (id === '') throw new PlanningSeedNotFoundError();
    const gate = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      approvalGateRepository.findById(id, tx),
    );
    if (
      !gate ||
      gate.workspaceId !== pctx.workspaceId ||
      gate.projectId !== pctx.projectId ||
      !gate.workItemId ||
      !isPlanningSeedGate(gate)
    ) {
      throw new PlanningSeedNotFoundError();
    }
    const pick = isPickSeedGate(gate);
    const chosenOption = pick ? readChosenOption(gate.chosenOption) : null;
    if (pick && !chosenOption) throw new PlanningSeedNotFoundError();
    const compose = refusalSeedComposerFor(gate.kind);
    if (!compose) throw new PlanningSeedNotFoundError();

    const ctx = { userId: pctx.userId, workspaceId: pctx.workspaceId };
    let item: WorkItemDto;
    try {
      item = await workItemsService.getWorkItem(gate.workItemId, ctx);
    } catch (err) {
      if (isNotVisible(err)) throw new PlanningSeedNotFoundError();
      /* v8 ignore next -- a real fault, never a 404. */
      throw err;
    }
    // A card moved out of the project after its gate was raised: the seeded turn
    // would be refused in this project, so no seed is offered for it here.
    if (item.projectId !== pctx.projectId) throw new PlanningSeedNotFoundError();

    // THE ANCHOR. A PICK walks UP from the choice's parent to the nearest
    // ancestor that is not done (by CATEGORY) and not archived, else the project
    // (`anchorOf`); the ancestor read is BOUND to the workspace, like the gate read
    // — unbound, a policy-gated table narrows to nothing and every pick would
    // silently anchor at the project. A design Re-plan anchors on the design card's
    // parent (`anchorKeyFor`, MOTIR-6424); every other refusal on its own card.
    const ancestors: SeedAncestor[] = pick ? await ancestorsOf(gate.workItemId, pctx) : [];
    const [anchorKey, waitingKeys] = await Promise.all([
      pick
        ? Promise.resolve(anchorOf(gate, item.identifier, ancestors))
        : anchorKeyFor(gate.kind, item, pctx),
      waitingKeysFor(gate.kind, item, pctx),
    ]);

    const firstTurn = compose(
      {
        card: { key: item.identifier, title: item.title },
        gate,
        supersedesKeys: replanOwedOf(gate, item.descriptionMd)?.keys ?? [],
        chosenOption,
        anchorKey,
        waitingKeys,
      },
      translatorFor(locale),
    );
    const seededSessionId = await planChangeSessionsService.findSeededSession(pctx, gate.id);

    return {
      gateId: gate.id,
      gateKind: gate.kind,
      intent: seedIntentOf(gate),
      anchorKey,
      firstTurn,
      seededSessionId,
      ...(chosenOption
        ? {
            pick: {
              choiceKey: item.identifier,
              choiceTitle: item.title,
              label: chosenOption.label,
              bestFor: chosenOption.bestFor,
              decidedAt: gate.decidedAt ? gate.decidedAt.toISOString() : null,
              decidedByLabel: gate.decidedByLabel ?? null,
            },
          }
        : {}),
    };
  },
  /**
   * The seed a guide's RE-PLAN OFFER gives the planning surface (story MOTIR-8684 ·
   * MOTIR-8692; decision MOTIR-8685), addressed by the offer's turn id — never its
   * text. Owner-only, like the Confirm that follows it; browse-gated on the GUIDED
   * card and on the TARGET; reads and writes nothing else.
   *
   * ⚠️ ONE REFUSAL — {@link PlanningSeedNotFoundError} — for every way there is
   * "nothing here for you": see {@link readGuideOfferFor}, plus a guided card or a
   * target the viewer cannot browse (or moved out of the project), and a target that
   * has become Done or archived since the offer landed. The `firstTurn` is the
   * request verbatim.
   */
  async getGuidePlanningSeed(
    guideTurnId: string,
    pctx: ProjectContext,
  ): Promise<PlanningGuideSeedDTO> {
    const id = guideTurnId.trim();
    if (id === '') throw new PlanningSeedNotFoundError();
    const { offer, targetKey, guidedKey, state } = await readGuideOfferFor(id, pctx);
    const [guided, target] = await Promise.all([
      visibleCardIn(guidedKey, pctx),
      visibleCardIn(targetKey, pctx),
    ]);
    await assertOpenTarget(target, pctx);
    const firstTurn = composeGuideSeedFirstTurn(offer);
    if (firstTurn === null || offer.targetResolution === 'none') {
      throw new PlanningSeedNotFoundError();
    }
    const seeded = await planChangeSessionsService.findGuideSeededSession(pctx, id);
    return {
      source: 'guide',
      guideTurnId: id,
      intent: 'plan',
      anchorKey: target.identifier,
      firstTurn,
      offerState: state,
      seededSessionId: seeded?.sessionId ?? null,
      seededSessionOpen: seeded?.open ?? false,
      guide: {
        guidedKey: guided.identifier,
        guidedTitle: guided.title,
        targetResolution: offer.targetResolution,
        confirmedAt: offer.confirmedAt,
      },
    };
  },
};
