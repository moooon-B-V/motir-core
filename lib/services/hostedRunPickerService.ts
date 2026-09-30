import { hostedRunModelService } from '@/lib/services/hostedRunModelService';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import type { HostedModelOffer } from '@/lib/hosted/resolveHostedModel';
import type {
  HostedPickerModelsDto,
  ResolvedWorkItemHostedModelDto,
} from '@/lib/dto/projectHostedAgentSettings';

// THE RUN HOSTED PICKER'S READ (MOTIR-6483; Story MOTIR-6989 · MOTIR-6996) —
// what `GET /api/hosted-runs/models` answers.
//
// motir-ai's offered list and its single default, exactly as before, plus —
// when the picker names its card — that card's resolved preselection and WHY
// (`projectHostedAgentSettingsService.resolveForWorkItem`, the same rule the
// start path runs, so the picker opens on the model a model-less start would
// use). motir-ai is asked ONCE for both.
//
// ⚠️ THE RESOLUTION NEVER BLOCKS THE PICKER. A card the caller cannot browse, a
// key that names nothing, or a failing read answers `resolved: null`, and the
// picker preselects as it always did. Only motir-ai's own silence is
// `unavailable` — the one state that disables the door.

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/** A refusal that means "not yours to read" — no resolution, and nothing to log. */
function isExpectedRefusal(err: unknown): boolean {
  return (
    err instanceof ProjectNotFoundError ||
    err instanceof WorkItemNotFoundError ||
    err instanceof PermissionDeniedError ||
    err instanceof ProjectAccessDeniedError
  );
}

/** The card's resolved model, browse-gated, or null when it cannot be told. */
async function resolveQuietly(
  workItemKey: string,
  offer: HostedModelOffer,
  ctx: ServiceContext,
): Promise<ResolvedWorkItemHostedModelDto | null> {
  try {
    const identifier = workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    return await projectHostedAgentSettingsService.resolveForWorkItem(item.id, ctx, offer);
  } catch (err) {
    if (!isExpectedRefusal(err)) {
      console.error(
        '[hosted-models] resolving the card model failed; preselecting the default',
        err,
      );
    }
    return null;
  }
}

export const hostedRunPickerService = {
  /**
   * The offered models and default; with `workItemKey`, also `resolved` — the
   * card's preselection, or null when it could not be resolved. Without it the
   * answer is exactly the pre-MOTIR-6996 shape (no `resolved` key).
   */
  async readModels(
    workItemKey: string | null,
    ctx: ServiceContext,
  ): Promise<HostedPickerModelsDto> {
    const offered = await hostedRunModelService.listOfferedModels();
    if (offered.state === 'unavailable') return { state: 'unavailable' };
    const base = { state: 'ok' as const, models: offered.models, default: offered.default };
    if (workItemKey === null) return base;
    const offer: HostedModelOffer = {
      models: offered.models.map((m) => m.id),
      default: offered.default,
      defaultsByDifficulty: offered.defaultsByDifficulty,
    };
    return { ...base, resolved: await resolveQuietly(workItemKey, offer, ctx) };
  },
};
