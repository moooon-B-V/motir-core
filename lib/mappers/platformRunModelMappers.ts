import type { User } from '@/generated/prisma/client';
import type { AgentModel, AgentModelDefaultsByDifficulty } from '@/lib/ai/motirAiClient';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import type {
  PlatformRunModelListDTO,
  PlatformRunModelProjectUseDTO,
} from '@/lib/dto/platformRunModel';
import type { PlatformRunModelRow } from '@/lib/repositories/platformRunModelRepository';
import type { ProjectHostedModelOverridesRow } from '@/lib/repositories/projectRepository';

const LEVELS: readonly WorkItemDifficultyDto[] = ['trivial', 'low', 'medium', 'high'];

const COLUMN: Record<WorkItemDifficultyDto, keyof ProjectHostedModelOverridesRow> = {
  trivial: 'hostedModelTrivial',
  low: 'hostedModelLow',
  medium: 'hostedModelMedium',
  high: 'hostedModelHigh',
};

export type ProjectOverrideRow = {
  identifier: string;
  name: string;
} & ProjectHostedModelOverridesRow;

/** The live projects that override a level to `model`, each with its levels. */
export function projectUsesOf(
  model: string,
  projects: readonly ProjectOverrideRow[],
): PlatformRunModelProjectUseDTO[] {
  const uses: PlatformRunModelProjectUseDTO[] = [];
  for (const p of projects) {
    const levels = LEVELS.filter((level) => p[COLUMN[level]] === model);
    if (levels.length > 0) uses.push({ projectKey: p.identifier, projectName: p.name, levels });
  }
  return uses;
}

/** The levels motir-ai's platform default puts on `model`. */
export function platformDefaultLevelsOf(
  model: string,
  defaults: AgentModelDefaultsByDifficulty,
): WorkItemDifficultyDto[] {
  return LEVELS.filter((level) => defaults[level] === model);
}

/**
 * The stored list + motir-ai's live offer + the estate's overrides → the page
 * DTO (MOTIR-7525). The list keeps its stored order; `addable` keeps motir-ai's.
 */
export function toPlatformRunModelListDTO(
  rows: readonly PlatformRunModelRow[],
  offer: { models: readonly AgentModel[]; defaultsByDifficulty: AgentModelDefaultsByDifficulty },
  projects: readonly ProjectOverrideRow[],
  users: readonly Pick<User, 'id' | 'name' | 'email'>[],
  canEdit: boolean,
): PlatformRunModelListDTO {
  const nameById = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
  const offeredById = new Map(offer.models.map((m) => [m.id, m]));
  const listed = new Set(rows.map((r) => r.model));
  return {
    entries: rows.map((r) => {
      const offered = offeredById.get(r.model);
      return {
        model: r.model,
        provider: offered?.provider ?? null,
        offered: !!offered,
        createdAt: r.createdAt.toISOString(),
        addedBy: r.addedById ? (nameById.get(r.addedById) ?? null) : null,
        seeded: !r.addedById,
        platformDefaultLevels: platformDefaultLevelsOf(r.model, offer.defaultsByDifficulty),
        projects: projectUsesOf(r.model, projects),
      };
    }),
    addable: offer.models
      .filter((m) => !listed.has(m.id))
      .map((m) => ({ id: m.id, provider: m.provider })),
    canEdit,
  };
}
