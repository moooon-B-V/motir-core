import { z } from 'zod/v4';

// The v1 ERROR RESPONSE, declared as a schema (Story 11.4 · Subtask 11.4.3 —
// MOTIR-2184).
//
// `ApiV1ErrorBody` (`lib/api/v1/errors.ts`) says the same thing, and says it as
// a TypeScript interface — which disappears at compile time. A generator cannot
// read an interface, so a document meant to be GENERATED from the code would
// have to hand-copy this shape: the two-artifacts-that-drift problem Story 11.4
// exists to prevent, reintroduced at the one place it is least visible. This is
// the same shape as a VALUE.
//
// The interface stays. It is what the wrapper's own code is typed against, and
// deleting it would put a runtime parse on every error path for no gain. What
// makes the two impossible to drift is not that one was removed but that
// `tests/api/v1/openapi-shared-schemas.test.ts` drives a REAL error through
// `classifyApiV1Error` and parses the result with this schema — the assertion the
// acceptance criteria ask for, and the reason it is not compared against a
// fixture written from the same assumption as the schema.
//
// Pinned by ADR §4 and Amendment 4.

/**
 * The body EVERY v1 failure returns, except 500.
 *
 * `.strict()` because the envelope is closed: a client branching on `code` must
 * be able to trust that nothing else is in there, and a stray field appearing
 * here would be a silent contract change under ADR §8.
 */
export const v1ErrorBodySchema = z
  .object({
    /**
     * A STABLE machine identifier — SCREAMING_SNAKE_CASE, never localized,
     * never reworded, never re-purposed. Clients branch on it, so changing one
     * is a breaking change under ADR §8.
     */
    code: z.string().min(1),
    /**
     * A human sentence for a developer reading a terminal. Reworded freely;
     * nothing may parse it.
     */
    error: z.string().min(1),
  })
  .strict();

/** The wire body of a v1 failure, inferred from the schema. */
export type V1ErrorBody = z.infer<typeof v1ErrorBodySchema>;

/**
 * The 500 body — the ONE failure with no `code`.
 *
 * A separate schema rather than `code` made optional on the one above, for the
 * same reason ADR Amendment 3 gave for keeping the two page envelopes apart: a
 * field that is sometimes absent tells a client nothing about which case it is
 * holding. An unexpected fault has no stable contract, and saying so with a
 * distinct shape is more honest than an optional field a client would have to
 * probe for.
 */
export const v1InternalErrorBodySchema = z.object({ error: z.string().min(1) }).strict();

/** The wire body of a v1 500. */
export type V1InternalErrorBody = z.infer<typeof v1InternalErrorBodySchema>;

/** The component name the emitted document registers the error envelope under. */
export const V1_ERROR_BODY_COMPONENT = 'ErrorBody';

/** The component name for the 500 body. */
export const V1_INTERNAL_ERROR_BODY_COMPONENT = 'InternalErrorBody';
