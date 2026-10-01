import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import type { HostedModelSource } from '@/lib/hosted/resolveHostedModel';

// DTOs for a project's HOSTED-AGENT settings (Story MOTIR-6989 · MOTIR-6993): the
// model a hosted run uses for each leaf difficulty, what the project overrode,
// and what motir-ai's platform default is. The shape the settings room
// (MOTIR-6995) reads and `GET /api/projects/[key]/hosted-agent-settings` answers.

/** One difficulty level's row. */
export interface HostedAgentLevelSettingDto {
  level: WorkItemDifficultyDto;
  /** The project's saved override, or null for "use the platform default". */
  override: string | null;
  /** Whether that override is on motir-ai's offered list right now. `true` when
   *  there is no override, so the flag reads "nothing to warn about". */
  overrideOffered: boolean;
  /** motir-ai's platform default for this level — null when it is not offered. */
  platformDefault: string | null;
  /** The model a hosted run on a leaf of this level uses, or null when nothing is offered. */
  effective: string | null;
  /** Why `effective` won; null when nothing is offered. */
  source: HostedModelSource | null;
}

/** One model motir-ai offers, with its provider — the room's select labels it
 *  `id` + `provider`, Run hosted's labelling (MOTIR-6995). */
export interface HostedAgentOfferedModelDto {
  id: string;
  provider: string;
}

export interface ProjectHostedAgentSettingsDto {
  /** The four levels, easiest first (`WORK_ITEM_DIFFICULTIES`' order). */
  levels: HostedAgentLevelSettingDto[];
  /** The offered bare model ids — the only values an override may take. */
  offeredModels: string[];
  /** The same list with each model's provider, in motir-ai's order (MOTIR-6995). */
  offered: HostedAgentOfferedModelDto[];
  /** What a leaf with NO difficulty runs on: motir-ai's single default, else the first offered. */
  noDifficulty: { effective: string | null; source: HostedModelSource | null };
}

/** A partial patch: an absent level is untouched, `null` resets it to the platform default. */
export type UpdateProjectHostedAgentSettingsInput = Partial<
  Record<WorkItemDifficultyDto, string | null>
>;

/** A card's resolved model and the difficulty it was resolved from. */
export interface ResolvedWorkItemHostedModelDto {
  model: string;
  source: HostedModelSource;
  /** The leaf's difficulty, or a parent's highest among its unfinished leaves; null when none. */
  difficulty: WorkItemDifficultyDto | null;
  /** Whether the card is a parent, so `difficulty` is the highest of its leaves. */
  fromLeaves: boolean;
}

/**
 * What the Run hosted picker reads (Story MOTIR-6989 · MOTIR-6996):
 * `GET /api/hosted-runs/models`'s answer. `resolved` is present only when the
 * read named a work item — the card's resolved preselection and why — and is
 * `null` when it could not be resolved; the picker then preselects as it always
 * did (`default`, else the first offered model).
 */
export type HostedPickerModelsDto =
  | { state: 'unavailable' }
  | {
      state: 'ok';
      models: { id: string; provider: string }[];
      default: string | null;
      resolved?: ResolvedWorkItemHostedModelDto | null;
    };
