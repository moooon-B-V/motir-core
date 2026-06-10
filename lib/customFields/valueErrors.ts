// Typed errors for the VALUES half of the custom-fields domain (Story 5.3 ·
// Subtask 5.3.3). The definitions half (5.3.2) ships its own errors module —
// the two halves are dispatched in parallel, so their files are disjoint by
// design; a later pass may consolidate them under lib/customFields/.
//
// The route/action layer maps codes to HTTP semantics:
//   CustomFieldNotFoundError                → 404 (unknown id, cross-workspace
//                                             probe, OR a field of a DIFFERENT
//                                             project — from this issue's
//                                             vantage point the field does not
//                                             exist; no existence leak)
//   every CustomFieldValueInvalidError kind → 422 (the per-type validation the
//                                             service is the authority for)
// Permission failures reuse the existing gates' errors (ProjectAccessDeniedError
// → 403 'edit' / 404 'browse'; WorkItemNotFoundError → 404), so the matrix is
// identical to every other issue edit.

/** Base class — `code` is the stable wire/i18n key (errors.customFields.<CODE>). */
export abstract class CustomFieldValueError extends Error {
  abstract readonly code: string;
}

/** Unknown / cross-workspace / cross-project field id → 404, no existence leak. */
export class CustomFieldNotFoundError extends CustomFieldValueError {
  readonly code = 'CUSTOM_FIELD_NOT_FOUND';
  constructor(readonly fieldId: string) {
    super(`Custom field ${fieldId} not found`);
  }
}

/** Base for every 422 the per-type validation produces. */
export abstract class CustomFieldValueInvalidError extends CustomFieldValueError {}

/** The raw value's JS shape doesn't match the field's type (e.g. number for a text field). */
export class CustomFieldValueTypeMismatchError extends CustomFieldValueInvalidError {
  readonly code = 'VALUE_TYPE_MISMATCH';
  constructor(readonly fieldType: string) {
    super(`Value does not match the ${fieldType} field type`);
  }
}

/** A text value beyond MAX_TEXT_VALUE_LENGTH. */
export class CustomFieldTextTooLongError extends CustomFieldValueInvalidError {
  readonly code = 'TEXT_TOO_LONG';
  constructor(readonly max: number) {
    super(`Text value exceeds ${max} characters`);
  }
}

/** A number value that isn't a finite decimal (NaN / ±∞ / non-numeric string). */
export class CustomFieldInvalidNumberError extends CustomFieldValueInvalidError {
  readonly code = 'INVALID_NUMBER';
  constructor() {
    super('Value is not a valid number');
  }
}

/** A date value that isn't a real date-only ISO calendar date. */
export class CustomFieldInvalidDateError extends CustomFieldValueInvalidError {
  readonly code = 'INVALID_DATE';
  constructor() {
    super('Value is not a valid date');
  }
}

/** An option id that doesn't exist on THIS field (unknown or cross-field). */
export class CustomFieldOptionNotInFieldError extends CustomFieldValueInvalidError {
  readonly code = 'OPTION_NOT_IN_FIELD';
  constructor(readonly optionId: string) {
    super(`Option ${optionId} does not belong to this field`);
  }
}

/**
 * An ARCHIVED option on a NEW write — the verified Jira rule: archived options
 * are hidden from new selection while existing values keep rendering. (Re-
 * setting the SAME archived option an issue already holds is a no-op, not an
 * error — nothing changes.)
 */
export class CustomFieldOptionArchivedError extends CustomFieldValueInvalidError {
  readonly code = 'OPTION_ARCHIVED';
  constructor(readonly optionId: string) {
    super('Archived options cannot be selected');
  }
}

/**
 * A user who may not be assigned here — not a workspace member who can VIEW
 * this project (the 6.4 assignableMembersService scoping, the same rule as
 * assignee / mentions).
 */
export class CustomFieldUserNotAssignableError extends CustomFieldValueInvalidError {
  readonly code = 'USER_NOT_ASSIGNABLE';
  constructor(readonly userId: string) {
    super('This user cannot be set on the project');
  }
}
