import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import type { ProjectHostedAgentSettingsDto } from '@/lib/dto/projectHostedAgentSettings';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import {
  resolveHostedModel,
  type HostedModelOffer,
  type HostedModelsByDifficulty,
} from '@/lib/hosted/resolveHostedModel';
import type { ProjectHostedModelOverridesRow } from '@/lib/repositories/projectRepository';

// Project row + motir-ai's offer → the hosted-agent settings DTO (MOTIR-6993).
// Every `effective` / `source` here comes from `resolveHostedModel`, the same
// function the start path and the picker call, so the room can never show a
// model a run would not use.

/** The four override columns, keyed by difficulty. */
export function toHostedModelOverrides(
  row: ProjectHostedModelOverridesRow,
): HostedModelsByDifficulty {
  return {
    trivial: row.hostedModelTrivial,
    low: row.hostedModelLow,
    medium: row.hostedModelMedium,
    high: row.hostedModelHigh,
  };
}

/** A difficulty-keyed patch → the column names it writes. */
export function toHostedModelOverrideColumns(
  patch: Partial<Record<WorkItemDifficultyDto, string | null>>,
): Partial<ProjectHostedModelOverridesRow> {
  const out: Partial<ProjectHostedModelOverridesRow> = {};
  if (patch.trivial !== undefined) out.hostedModelTrivial = patch.trivial;
  if (patch.low !== undefined) out.hostedModelLow = patch.low;
  if (patch.medium !== undefined) out.hostedModelMedium = patch.medium;
  if (patch.high !== undefined) out.hostedModelHigh = patch.high;
  return out;
}

export function toProjectHostedAgentSettingsDto(
  row: ProjectHostedModelOverridesRow,
  offered: HostedModelOffer,
): ProjectHostedAgentSettingsDto {
  const overrides = toHostedModelOverrides(row);
  const noDifficulty = resolveHostedModel({ difficulty: null, overrides, offered });
  return {
    levels: WORK_ITEM_DIFFICULTIES.map((level) => {
      const override = overrides[level];
      const resolved = resolveHostedModel({ difficulty: level, overrides, offered });
      return {
        level,
        override,
        overrideOffered: override === null || offered.models.includes(override),
        platformDefault: offered.defaultsByDifficulty[level],
        effective: resolved?.model ?? null,
        source: resolved?.source ?? null,
      };
    }),
    offeredModels: [...offered.models],
    noDifficulty: { effective: noDifficulty?.model ?? null, source: noDifficulty?.source ?? null },
  };
}
