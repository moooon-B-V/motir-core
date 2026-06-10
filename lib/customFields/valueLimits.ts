// Value-side bound for the custom-fields domain (Story 5.3 · Subtask 5.3.3).
// Pure constant (no Prisma import) so the rail editor (5.3.7) can render the
// limit from the same source of truth the service enforces. The definition-
// side caps (50 fields / 55 options) live with the definitions half (5.3.2).

/** Max length of a `text` custom-field value, after trimming. */
export const MAX_TEXT_VALUE_LENGTH = 1000;
