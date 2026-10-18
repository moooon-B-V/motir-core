import type { ProjectAutoTranslateChange } from '@/generated/prisma/client';
import type {
  ProjectAutoTranslateChangeDTO,
  ProjectAutoTranslateSettingsDTO,
} from '@/lib/dto/projectAutoTranslateSettings';

/**
 * A trail row as the room reads it. `names` maps user id → display name for the
 * actors that still resolve; an actor that does not keeps a `null` name rather
 * than failing the read or dropping the change.
 */
export function toProjectAutoTranslateChangeDTO(
  row: ProjectAutoTranslateChange,
  names: ReadonlyMap<string, string>,
): ProjectAutoTranslateChangeDTO {
  return {
    id: row.id,
    changedByUserId: row.changedByUserId,
    changedByName: row.changedByUserId ? (names.get(row.changedByUserId) ?? null) : null,
    fromEnabled: row.fromEnabled,
    toEnabled: row.toEnabled,
    changedAt: row.changedAt.toISOString(),
  };
}

export function toProjectAutoTranslateSettingsDTO(
  autoTranslateWorkContent: boolean,
  rows: ProjectAutoTranslateChange[],
  totalChanges: number,
  names: ReadonlyMap<string, string>,
): ProjectAutoTranslateSettingsDTO {
  return {
    autoTranslateWorkContent,
    changes: rows.map((row) => toProjectAutoTranslateChangeDTO(row, names)),
    totalChanges,
  };
}
