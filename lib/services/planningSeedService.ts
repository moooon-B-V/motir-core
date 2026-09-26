import { createTranslator } from 'next-intl';
import type { ApprovalGateKind } from '@/generated/prisma/client';
import type { ProjectContext } from '@/lib/projects';
import type { Locale } from '@/lib/i18n/locales';
import { getMessagesFor } from '@/lib/i18n/messages';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { isTerminalStatus } from '@/lib/workItems/blockerReadiness';
import { workItemsService } from '@/lib/services/workItemsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { replanOwedOf } from '@/lib/approvalGates/decisionRecord';
import {
  REFUSAL_SEED_NAMESPACE,
  isRefusalSeedGate,
  refusalSeedAnchorsOnParent,
  refusalSeedComposerFor,
  type SeedTranslator,
} from '@/lib/planning/refusalSeed';
import { PlanningSeedNotFoundError } from '@/lib/planChange/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { PlanningSeedDTO } from '@/lib/dto/planningSeed';
import type { WorkItemDto } from '@/lib/dto/workItems';

// THE REFUSAL SEED read (story MOTIR-6068 · MOTIR-6208; `approval-gates.md`
// §10f): addressed by the GATE ID, never by the reason's text in a URL. The gate
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

export const planningSeedService = {
  /**
   * The seed a refused gate offers the planning surface, for THIS viewer.
   *
   * ⚠️ ONE REFUSAL — {@link PlanningSeedNotFoundError} — for an unknown id, a
   * gate in another workspace or project (the viewer's active project is the
   * one the seeded turn will be sent in, and the seed guard refuses any other),
   * a card-less gate, a gate whose work item the viewer cannot browse, a gate
   * that is not a refusal `isRefusalSeedGate` accepts, and a refused kind with no
   * registered composer. Nothing in the answer tells them apart.
   *
   * `seededSessionId` is the viewer's own recent session seeded by this gate
   * (`findSeededSession`), else `null`.
   */
  async getRefusalSeed(
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
      !isRefusalSeedGate(gate)
    ) {
      throw new PlanningSeedNotFoundError();
    }
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

    const [anchorKey, waitingKeys] = await Promise.all([
      anchorKeyFor(gate.kind, item, pctx),
      waitingKeysFor(gate.kind, item, pctx),
    ]);
    const firstTurn = compose(
      {
        card: { key: item.identifier, title: item.title },
        gate,
        supersedesKeys: replanOwedOf(gate, item.descriptionMd)?.keys ?? [],
        anchorKey,
        waitingKeys,
      },
      translatorFor(locale),
    );
    const seededSessionId = await planChangeSessionsService.findSeededSession(pctx, gate.id);

    return {
      gateId: gate.id,
      gateKind: gate.kind,
      anchorKey,
      firstTurn,
      seededSessionId,
    };
  },
};
