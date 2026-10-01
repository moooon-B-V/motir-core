import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';

// WHICH MODEL A HOSTED RUN USES (Story MOTIR-6989 · MOTIR-6993) — the ONE rule
// the settings room, the Run hosted picker and the start path all read, so the
// three can never disagree about a card's model.
//
// Pure: no I/O, no clock, no Prisma. The caller supplies what motir-ai offers
// (the list, its single `default` and its per-level `defaultsByDifficulty`) and
// the project's four overrides; the answer names the model and WHY it won.
//
// Precedence, first match wins:
//   1. `override`          — the project's override for the level, if still offered;
//   2. `platform_level`    — motir-ai's default for the level, if offered;
//   3. `platform_default`  — motir-ai's single `default`, if offered;
//   4. `first_offered`     — the first model on the offered list.
// A card with no difficulty skips 1 and 2. An override motir-ai has since
// WITHDRAWN is skipped, never an error — the settings room flags it instead.
// With nothing offered at all the answer is `null`: there is no model to run.

/** The four per-level values, keyed by difficulty. */
export type HostedModelsByDifficulty = Record<WorkItemDifficultyDto, string | null>;

/** Why the resolved model won. */
export type HostedModelSource =
  | 'override'
  | 'platform_level'
  | 'platform_default'
  | 'first_offered';

export interface HostedModelOffer {
  /** The offered bare ids, in motir-ai's order. */
  models: readonly string[];
  /** motir-ai's single default — already null when it is not offered. */
  default: string | null;
  /** motir-ai's per-level defaults — each already null when it is not offered. */
  defaultsByDifficulty: HostedModelsByDifficulty;
}

export interface ResolveHostedModelInput {
  difficulty: WorkItemDifficultyDto | null;
  overrides: HostedModelsByDifficulty;
  offered: HostedModelOffer;
}

export type ResolvedHostedModel = { model: string; source: HostedModelSource } | null;

export function resolveHostedModel({
  difficulty,
  overrides,
  offered,
}: ResolveHostedModelInput): ResolvedHostedModel {
  const isOffered = (id: string | null): id is string => id !== null && offered.models.includes(id);

  if (difficulty !== null) {
    const override = overrides[difficulty];
    if (isOffered(override)) return { model: override, source: 'override' };
    const level = offered.defaultsByDifficulty[difficulty];
    if (isOffered(level)) return { model: level, source: 'platform_level' };
  }
  if (isOffered(offered.default)) return { model: offered.default, source: 'platform_default' };
  const first = offered.models[0];
  return first === undefined ? null : { model: first, source: 'first_offered' };
}

/**
 * The difficulty a PARENT card runs on: the highest among its unfinished leaf
 * descendants (easiest → hardest is `WORK_ITEM_DIFFICULTIES`' order). A leaf with
 * no difficulty adds nothing; `null` when no unfinished leaf carries one.
 */
export function highestDifficulty(
  levels: readonly (WorkItemDifficultyDto | null)[],
  order: readonly WorkItemDifficultyDto[],
): WorkItemDifficultyDto | null {
  let best = -1;
  for (const level of levels) {
    if (level === null) continue;
    best = Math.max(best, order.indexOf(level));
  }
  return best < 0 ? null : (order[best] ?? null);
}
