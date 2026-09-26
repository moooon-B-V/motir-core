import { createTranslator } from 'next-intl';
import type { ProjectContext } from '@/lib/projects';
import type { Locale } from '@/lib/i18n/locales';
import { getMessagesFor } from '@/lib/i18n/messages';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { replanOwedOf } from '@/lib/approvalGates/decisionRecord';
import {
  REFUSAL_SEED_NAMESPACE,
  isRefusalSeedGate,
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

    const firstTurn = compose(
      {
        card: { key: item.identifier, title: item.title },
        gate,
        supersedesKeys: replanOwedOf(gate, item.descriptionMd)?.keys ?? [],
      },
      translatorFor(locale),
    );
    const seededSessionId = await planChangeSessionsService.findSeededSession(pctx, gate.id);

    return {
      gateId: gate.id,
      gateKind: gate.kind,
      anchorKey: item.identifier,
      firstTurn,
      seededSessionId,
    };
  },
};
