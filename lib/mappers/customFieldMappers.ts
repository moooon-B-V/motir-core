import type { CustomFieldDefinition, CustomFieldOption } from '@prisma/client';
import type {
  CustomFieldDefinitionDTO,
  CustomFieldOptionDTO,
  DeletedCustomFieldDTO,
} from '@/lib/dto/customFields';

// Prisma → DTO converters for the custom-fields definitions surface (Story
// 5.3 · Subtask 5.3.2). Pure functions, called by customFieldsService just
// before returning (CLAUDE.md — services return DTOs, never raw models).

export function toCustomFieldOptionDTO(
  option: CustomFieldOption,
  valueCount: number,
): CustomFieldOptionDTO {
  return {
    id: option.id,
    label: option.label,
    position: option.position,
    archived: option.archived,
    valueCount,
  };
}

/**
 * Assemble the admin-list DTO from the definition row, its (position-ordered)
 * options, and the issue-value counts the service resolved alongside —
 * `valueCount` for the field, `optionCounts` (option id → count) for each
 * option's usage gloss (5.3.6); options absent from the map count 0.
 */
export function toCustomFieldDefinitionDTO(
  definition: CustomFieldDefinition,
  options: CustomFieldOption[],
  valueCount: number,
  optionCounts?: ReadonlyMap<string, number>,
): CustomFieldDefinitionDTO {
  return {
    id: definition.id,
    key: definition.key,
    label: definition.label,
    fieldType: definition.fieldType,
    description: definition.description ?? null,
    position: definition.position,
    options: options.map((o) => toCustomFieldOptionDTO(o, optionCounts?.get(o.id) ?? 0)),
    valueCount,
  };
}

/** The hard-delete receipt — what the cascade destroyed, for the UI confirm. */
export function toDeletedCustomFieldDTO(
  definition: CustomFieldDefinition,
  valueCount: number,
): DeletedCustomFieldDTO {
  return {
    id: definition.id,
    key: definition.key,
    label: definition.label,
    valueCount,
  };
}
