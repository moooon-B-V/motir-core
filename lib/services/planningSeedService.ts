import { createTranslator } from 'next-intl';
import type { ProjectContext } from '@/lib/projects';
import type { Locale } from '@/lib/i18n/locales';
import { getMessagesFor } from '@/lib/i18n/messages';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { replanOwedOf } from '@/lib/approvalGates/decisionRecord';
import {
  REFUSAL_SEED_NAMESPACE,
  anchorOf,
  isPickSeedGate,
  isPlanningSeedGate,
  readChosenOption,
  refusalSeedComposerFor,
  seedIntentOf,
  toSeedAncestors,
  type SeedAncestor,
  type SeedTranslator,
} from '@/lib/planning/refusalSeed';
import { PlanningSeedNotFoundError } from '@/lib/planChange/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { PlanningSeedDTO } from '@/lib/dto/planningSeed';
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

    // THE ANCHOR. A refusal anchors on its own card; a pick walks UP from the
    // choice's parent to the nearest ancestor that is not done (by CATEGORY) and
    // not archived, else the project (`anchorOf`). The ancestor read is BOUND to
    // the workspace, like the gate read — unbound, a policy-gated table narrows to
    // nothing and every pick would silently anchor at the project.
    const ancestors: SeedAncestor[] = pick ? await ancestorsOf(gate.workItemId, pctx) : [];
    const anchorKey = anchorOf(gate, item.identifier, ancestors);

    const firstTurn = compose(
      {
        card: { key: item.identifier, title: item.title },
        gate,
        supersedesKeys: replanOwedOf(gate, item.descriptionMd)?.keys ?? [],
        chosenOption,
        anchorKey,
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
};
