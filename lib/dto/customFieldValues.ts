// DTOs for the VALUES half of the custom-fields domain (Story 5.3 · Subtask
// 5.3.3) — the read shape the issue-detail rail consumes and the input the
// set-value flow accepts. The definitions half (5.3.2 — the admin page's
// field/option management DTOs) ships its own module; the halves are
// dispatched in parallel so their files are disjoint by design.

/** The five field types — each a verified member of Jira's team-managed set. */
export type CustomFieldTypeDto = 'text' | 'number' | 'date' | 'select' | 'user';

/**
 * One managed option of a `select` field, as the rail needs it: `archived`
 * rides along so the picker can EXCLUDE archived options from new selection
 * while a current-but-archived value still renders (with its archived mark).
 */
export interface CustomFieldOptionDto {
  id: string;
  label: string;
  archived: boolean;
}

/** The user a `user`-type value resolves to, display-ready (the avatar trio). */
export interface CustomFieldValueUserDto {
  id: string;
  name: string;
  image: string | null;
}

/**
 * One issue's value for one field, resolved for display. Exactly ONE member is
 * non-null, matching the field's type (the typed-EAV row's populated column):
 * `number` follows the `storyPoints` DTO convention (JS number); `date` is a
 * full ISO-8601 instant at UTC midnight (the `dueDate` convention — the rail
 * slices the YYYY-MM-DD); `option` / `user` arrive resolved so the rail never
 * re-derives a label from an id.
 */
export interface CustomFieldValueDto {
  text: string | null;
  number: number | null;
  date: string | null;
  option: CustomFieldOptionDto | null;
  user: CustomFieldValueUserDto | null;
}

/**
 * A field definition + THIS issue's value — the element of the
 * `IssueDetailDto.customFields` array (definitions in `position` order, ≤50
 * by the project cap). `value` is null when the issue holds none — the rail
 * still needs the definition then, for the "Show more fields" disclosure.
 * `options` is the field's full option set in position order ([] for
 * non-select types); archived rows are INCLUDED (the picker filters, the
 * renderer needs them for a current-but-archived value).
 */
export interface CustomFieldWithValueDto {
  id: string;
  key: string;
  label: string;
  fieldType: CustomFieldTypeDto;
  description: string | null;
  options: CustomFieldOptionDto[];
  value: CustomFieldValueDto | null;
}

/**
 * The raw value `setValue` accepts — interpreted per the field's type:
 * `text` → string · `number` → number, or a numeric string (the form keeps
 * the user's scale, e.g. "1.50") · `date` → date-only ISO `YYYY-MM-DD` (a
 * full ISO instant at UTC midnight is also accepted — the rail's dueDate
 * convention) · `select` → option id · `user` → user id. `null` clears.
 */
export type SetCustomFieldValueInput = string | number | null;
