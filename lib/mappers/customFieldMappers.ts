import type { CustomFieldDefinition, CustomFieldOption } from '@prisma/client';
import type {
  CustomFieldDefinitionDTO,
  CustomFieldOptionDTO,
  DeletedCustomFieldDTO,
} from '@/lib/dto/customFields';

// Prisma → DTO converters for the custom-fields definitions surface (Story
// 5.3 · Subtask 5.3.2). Pure functions, called by customFieldsService just
// before returning (CLAUDE.md — services return DTOs, never raw models).

export function toCustomFieldOptionDTO(option: CustomFieldOption): CustomFieldOptionDTO {
  return {
    id: option.id,
    label: option.label,
    position: option.position,
    archived: option.archived,
  };
}

/**
 * Assemble the admin-list DTO from the definition row, its (position-ordered)
 * options, and the issue-value count the service resolved alongside.
 */
export function toCustomFieldDefinitionDTO(
  definition: CustomFieldDefinition,
  options: CustomFieldOption[],
  valueCount: number,
): CustomFieldDefinitionDTO {
  return {
    id: definition.id,
    key: definition.key,
    label: definition.label,
    fieldType: definition.fieldType,
    description: definition.description ?? null,
    position: definition.position,
    options: options.map(toCustomFieldOptionDTO),
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
