// Custom-project-role caps (Story MOTIR-2257 · Subtask MOTIR-2472). Pure
// constants — NO Prisma import — so the role editor can render the cap state
// (the disabled `Create role` button and its explanation, drawn in
// `design/projects/roles-permissions.mock.html` panel 6) from the SAME source of
// truth the service enforces, and the button and the refusal can never disagree.
// The shape `lib/customFields/limits.ts` established for field caps.

/**
 * Max CUSTOM roles per project. The three built-ins are code, not rows, and are
 * never counted against it.
 *
 * ⚠️ A cap on a settings vocabulary is a cheap guard that keeps every read of it
 * bounded (finding #57): the Roles & permissions list is at most
 * `3 + MAX_CUSTOM_ROLES_PER_PROJECT` rows, and the Members picker's option list
 * inherits the same bound. Ten is chosen against what the surface can carry
 * rather than against a mirror product's number: the roles asset measured its
 * drill-down as having no width ceiling, so the binding constraint is a person's
 * ability to keep the vocabulary in their head — the same argument the design
 * makes for starting a role from a base rather than an empty grid.
 */
export const MAX_CUSTOM_ROLES_PER_PROJECT = 10;

/**
 * Max length of a role's name. Matches `MAX_LABEL_LENGTH` in
 * `lib/customFields/limits.ts` — the same "a name a human typed" bound, so two
 * settings surfaces do not disagree about how long a label may be.
 */
export const MAX_ROLE_NAME_LENGTH = 255;
