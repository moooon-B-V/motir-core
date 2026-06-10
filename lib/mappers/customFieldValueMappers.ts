import type { CustomFieldOption } from '@prisma/client';
import type { CustomFieldDefinitionWithItemValue } from '@/lib/repositories/customFieldDefinitionRepository';
import type { CustomFieldValueWithRefs } from '@/lib/repositories/customFieldValueRepository';
import type {
  CustomFieldOptionDto,
  CustomFieldValueDto,
  CustomFieldWithValueDto,
} from '@/lib/dto/customFieldValues';

// Prisma → DTO mappers for the custom-field VALUES read path (Story 5.3 ·
// Subtask 5.3.3). Conventions match the existing mappers: Decimal → JS number
// (the `storyPoints` rule), DateTime → full ISO-8601 string (the `dueDate`
// rule — a @db.Date column round-trips as UTC midnight, so the instant IS the
// calendar date), relations resolved to display-ready shapes at the boundary.

export function toCustomFieldOptionDto(row: CustomFieldOption): CustomFieldOptionDto {
  return { id: row.id, label: row.label, archived: row.archived };
}

/**
 * One value ROW to its resolved DTO. Exactly one member comes out non-null —
 * the populated typed-EAV column (the service guarantees the row shape; a
 * row whose option/user was since deleted falls back to null members, which
 * the rail renders as empty).
 */
export function toCustomFieldValueDto(row: CustomFieldValueWithRefs): CustomFieldValueDto {
  return {
    text: row.valueText,
    number: row.valueNumber === null ? null : Number(row.valueNumber),
    date: row.valueDate === null ? null : row.valueDate.toISOString(),
    option: row.valueOption === null ? null : toCustomFieldOptionDto(row.valueOption),
    user: row.valueUser === null ? null : { ...row.valueUser },
  };
}

/**
 * One definition (+ this issue's value rows, ≤1 by the pair unique) to the
 * `IssueDetailDto.customFields` element. An issue with no row for the field
 * maps to `value: null` — the definition still ships, the "Show more fields"
 * disclosure needs it.
 */
export function toCustomFieldWithValueDto(
  row: CustomFieldDefinitionWithItemValue,
): CustomFieldWithValueDto {
  const valueRow = row.values[0] ?? null;
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    fieldType: row.fieldType,
    description: row.description,
    options: row.options.map(toCustomFieldOptionDto),
    value: valueRow === null ? null : toCustomFieldValueDto(valueRow),
  };
}
