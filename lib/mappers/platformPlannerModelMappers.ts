import type { User } from '@/generated/prisma/client';
import {
  PLANNER_AUDIENCES,
  type PlannerModelSettingsRead,
  type PlannerModelWriteResult,
} from '@/lib/ai/types';
import type {
  PlatformPlannerModelRowDTO,
  PlatformPlannerModelSettingsDTO,
  PlatformPlannerModelWriteDTO,
} from '@/lib/dto/platformPlannerModel';

/**
 * motir-ai's planner-model read → the console DTO (MOTIR-7227).
 *
 * The rows are put in `customer`, `meta`, `internal` order HERE rather than
 * trusted from the wire, so the page's order is a property of this build and not
 * of whichever motir-ai answered. An audience motir-ai did not return is left
 * out rather than invented — the page draws what exists, never a guess.
 */
export function toPlatformPlannerModelSettingsDTO(
  read: PlannerModelSettingsRead,
  users: readonly Pick<User, 'id' | 'name' | 'email'>[],
  canEdit: boolean,
): PlatformPlannerModelSettingsDTO {
  const nameById = new Map(users.map((u) => [u.id, u.name?.trim() || u.email]));
  const rows: PlatformPlannerModelRowDTO[] = [];
  for (const audience of PLANNER_AUDIENCES) {
    const s = read.settings.find((x) => x.audience === audience);
    if (!s) continue;
    rows.push({
      audience,
      model: s.model,
      offered: s.offered,
      reachable: s.reachable ?? null,
      lastProbeAt: s.lastProbeAt ?? null,
      lastProbeError: s.lastProbeError ?? null,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedByCoreUserId ? (nameById.get(s.updatedByCoreUserId) ?? null) : null,
      seeded: !s.updatedByCoreUserId,
    });
  }
  return {
    rows,
    offered: read.offered.map((m) => ({ id: m.id, provider: m.provider })),
    canEdit,
  };
}

/** motir-ai's write answer → the console DTO, with `fromModel` as core audited it. */
export function toPlatformPlannerModelWriteDTO(
  result: PlannerModelWriteResult,
  fromModel: string,
): PlatformPlannerModelWriteDTO {
  return {
    audience: result.audience,
    fromModel,
    toModel: result.model,
    updatedAt: result.updatedAt,
  };
}
