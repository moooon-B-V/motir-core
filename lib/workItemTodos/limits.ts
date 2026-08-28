// The to-do granularity BAR, as a number (Story MOTIR-3808 · MOTIR-3813), per
// `docs/decisions/work-item-todo-list.md` §1.
//
// ⚠️ THE POINT OF THIS FILE IS THAT THE NUMBER HAS ONE HOME. "A to-do is one
// operation" stated in a design note is a bar the first tired author walks
// past; stated as a value the service rejects past, it is a bar the product
// holds. But a bar enforced in two places is a bar that drifts — so the
// service, the DTO's documented contract, the error message a user reads and
// every test assert against THESE constants, never against a literal.
//
// The ADR weighs the alternative (a `VARCHAR(n)` column width) and declines it:
// a width overflow surfaces as a raw Prisma `P2000`, not as the typed domain
// error the 4-layer contract requires a route to translate, and widening the
// bar later would become a migration for no benefit. The column is `TEXT`; the
// bar lives here.

/**
 * The longest a to-do's `text` may be, in characters.
 *
 * 200 is measured against the operations the story itself names — *"change 1
 * setting in the UI"*, *"run one cli command"* — which run 40–90 characters
 * with room for a qualifier. It is comfortably above every honest
 * one-operation line and comfortably below a paragraph. **A step that does not
 * fit in 200 characters is two steps, or it is a work item.**
 */
export const TODO_TEXT_MAX_LENGTH = 200;

/**
 * The longest a to-do's `commandText` may be, in characters.
 *
 * Deliberately far above {@link TODO_TEXT_MAX_LENGTH}: a real command with
 * flags and a URL runs long, and this cap exists to keep a shell SCRIPT out of
 * the field, not to keep a `curl` out.
 */
export const TODO_COMMAND_MAX_LENGTH = 500;
