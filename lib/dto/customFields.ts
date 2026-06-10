import type { CustomFieldType } from '@prisma/client';

// DTOs for the custom-fields definitions surface (Story 5.3 · Subtask 5.3.2)
// — what crosses the API boundary from customFieldsService. The VALUE-side
// DTOs (the detail-rail `CustomFieldWithValueDto` shape) are Subtask 5.3.3's.

/** One managed option of a `select` field, in `position` order. */
export interface CustomFieldOptionDTO {
  id: string;
  label: string;
  /** Fractional-index key — opaque, lexicographically sortable. */
  position: string;
  /**
   * Archived options are hidden from NEW selection but keep rendering on
   * issues that already hold them (the verified Jira team-managed split).
   */
  archived: boolean;
}

/**
 * One custom-field definition as the Fields admin page consumes it:
 * the definition row, its option set (empty for non-`select` types), and
 * how many issues currently hold a value for it (the number the
 * delete-field confirm names).
 */
export interface CustomFieldDefinitionDTO {
  id: string;
  /** The immutable machine slug revision diffs + Epic-6 predicates reference. */
  key: string;
  label: string;
  fieldType: CustomFieldType;
  description: string | null;
  /** Fractional-index key — opaque, lexicographically sortable. */
  position: string;
  /** `position`-ordered option set; always `[]` for non-`select` fields. */
  options: CustomFieldOptionDTO[];
  /** How many issues hold a value for this field. */
  valueCount: number;
}

/**
 * The receipt a hard field-delete returns (team-managed semantics: immediate,
 * permanent, values destroyed) — `valueCount` is the number of issue values
 * the cascade took with it, counted in the same transaction.
 */
export interface DeletedCustomFieldDTO {
  id: string;
  key: string;
  label: string;
  valueCount: number;
}
