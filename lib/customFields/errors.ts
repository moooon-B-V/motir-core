// Typed errors for the custom-fields domain (Story 5.3 · Subtask 5.3.2).
// Kept in their own file so callers — route handlers, server actions, server
// components — can import them without pulling in the Prisma client.
//
// Per CLAUDE.md, services throw typed errors with stable string `code`s; the
// route layer translates them to HTTP statuses (the shared mapping lives in
// lib/customFields/errorResponse.ts): not-found → 404 (incl. the
// no-existence-leak 404 for cross-workspace ids, finding #44), the
// admin-gate denial reuses NotProjectAdminError from lib/projects/errors
// (→ 403), input-shape errors → 400, the 50/55 caps → 422, and
// in-use / conflict → 409.

import { MAX_LABEL_LENGTH } from '@/lib/customFields/limits';

export class CustomFieldNotFoundError extends Error {
  readonly code = 'CUSTOM_FIELD_NOT_FOUND' as const;
  constructor(fieldId: string) {
    super(`Custom field ${fieldId} not found.`);
    this.name = 'CustomFieldNotFoundError';
  }
}

export class CustomFieldOptionNotFoundError extends Error {
  readonly code = 'CUSTOM_FIELD_OPTION_NOT_FOUND' as const;
  constructor(optionId: string) {
    super(`Custom-field option ${optionId} not found.`);
    this.name = 'CustomFieldOptionNotFoundError';
  }
}

export class InvalidFieldTypeError extends Error {
  readonly code = 'INVALID_FIELD_TYPE' as const;
  constructor(fieldType: string) {
    super(`"${fieldType}" is not a custom-field type (use text, number, date, select, or user).`);
    this.name = 'InvalidFieldTypeError';
  }
}

/** An empty (or over-long) field / option label. `what` names which. */
export class InvalidFieldLabelError extends Error {
  readonly code = 'INVALID_FIELD_LABEL' as const;
  constructor(what: 'field' | 'option') {
    super(`A ${what} label must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters.`);
    this.name = 'InvalidFieldLabelError';
  }
}

/** An option operation aimed at a field whose type is not `select`. */
export class NotASelectFieldError extends Error {
  readonly code = 'NOT_A_SELECT_FIELD' as const;
  constructor(fieldId: string) {
    super(`Custom field ${fieldId} is not a select field, so it has no options.`);
    this.name = 'NotASelectFieldError';
  }
}

/** A reorder carrying an empty / non-string fractional position key. */
export class InvalidPositionError extends Error {
  readonly code = 'INVALID_POSITION' as const;
  constructor() {
    super('A reorder requires a non-empty fractional position key.');
    this.name = 'InvalidPositionError';
  }
}

/** The 50-fields-per-project cap (the documented Jira team-managed limit). */
export class FieldLimitReachedError extends Error {
  readonly code = 'FIELD_LIMIT_REACHED' as const;
  constructor(readonly limit: number) {
    super(`This project already has ${limit} custom fields, the maximum.`);
    this.name = 'FieldLimitReachedError';
  }
}

/** The 55-options-per-field cap (the documented Jira team-managed limit). */
export class OptionLimitReachedError extends Error {
  readonly code = 'OPTION_LIMIT_REACHED' as const;
  constructor(readonly limit: number) {
    super(`This field already has ${limit} options, the maximum.`);
    this.name = 'OptionLimitReachedError';
  }
}

/**
 * Deleting an option that issues still hold — the verified team-managed
 * "Optimize" rule is delete-only-when-unused; the UI offers archive instead.
 */
export class OptionInUseError extends Error {
  readonly code = 'OPTION_IN_USE' as const;
  constructor(
    optionId: string,
    readonly valueCount: number,
  ) {
    super(
      `Option ${optionId} is in use on ${valueCount} issue${valueCount === 1 ? '' : 's'} ` +
        `and cannot be deleted — archive it instead.`,
    );
    this.name = 'OptionInUseError';
  }
}

/**
 * The DB-unique backstop on the immutable per-project `key`: only reachable
 * when a concurrent create wins the same generated key between the in-tx
 * uniquify read and the insert.
 */
export class FieldKeyConflictError extends Error {
  readonly code = 'FIELD_KEY_CONFLICT' as const;
  constructor(key: string) {
    super(`A custom field with the key "${key}" already exists in this project — retry.`);
    this.name = 'FieldKeyConflictError';
  }
}
