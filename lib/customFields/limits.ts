// Custom-field caps (Story 5.3) — the documented Jira team-managed limits,
// adopted as cheap guards that keep every custom-fields read bounded
// (finding #57): the admin list is ≤ MAX_FIELDS_PER_PROJECT rows, an option
// set ≤ MAX_OPTIONS_PER_FIELD, and the detail-rail join (5.3.3) inherits the
// same bound. Pure constants (no Prisma import) so the settings UI (5.3.6)
// can render the cap states from the same source of truth the service
// enforces.

/** Max custom-field definitions per project (the documented Jira cap). */
export const MAX_FIELDS_PER_PROJECT = 50;

/** Max options per `select` field (the documented Jira cap). */
export const MAX_OPTIONS_PER_FIELD = 55;

/** Max length of a field / option label (the Jira field-name bound). */
export const MAX_LABEL_LENGTH = 255;
