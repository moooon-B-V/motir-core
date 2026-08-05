import { z } from 'zod/v4';
import { V1_COLLECTIONS } from '@/lib/api/v1/pagination';

// The TWO v1 page envelopes, declared as schemas (Story 11.4 · Subtask 11.4.3 —
// MOTIR-2184).
//
// `ListEnvelope<T>` and `RankedListEnvelope<T>` (`lib/api/v1/pagination.ts`) are
// the same two shapes as TypeScript generics, which a generator cannot read.
// These are the value form, and they stay GENERIC over the item schema so an
// operation composes the envelope with its resource's own schema rather than
// restating either — the assembly Amendment 2 gave this story, applied to the
// pagination half.
//
// ⚠️ TWO envelopes, NOT one with an optional `totalCount`. This is an explicit
// ADR obligation rather than a preference: Amendment 3 Q2 says *"the OpenAPI
// assembly emits TWO named envelope schemas, and each operation references the
// one its route returns"*, and it rejected the collapsed form by name. The
// reason is the one `RankedListEnvelope`'s own comment gives — a count a client
// cannot distinguish from a real answer is a shape that lies. A collection
// either promises a total or it does not, and the wire type is where that
// promise is legible.

/**
 * The plain cursor page — what MOST v1 collections return.
 *
 * `nextCursor` is `null` on the last page, never absent: a client's paging loop
 * tests one field, and "absent" and "null" being different terminal signals is
 * exactly the ambiguity the two-envelope rule exists to avoid.
 */
export function v1PageEnvelopeSchema<T extends z.ZodType>(item: T) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
    })
    .strict();
}

/**
 * The RANKED collection page — the plain envelope plus the total behind it.
 *
 * Returned only by collections whose shipped read already computes the count as
 * a bounded aggregate (the backlog and a sprint's members, both from
 * `RankedIssuePageDto`). Every other collection returns
 * {@link v1PageEnvelopeSchema} and omits the field ENTIRELY — absent, never
 * `null` and never `0`.
 */
export function v1RankedPageEnvelopeSchema<T extends z.ZodType>(item: T) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable(),
      totalCount: z.number().int().nonnegative(),
    })
    .strict();
}

/** The component name the emitted document registers the plain envelope under. */
export const V1_PAGE_ENVELOPE_COMPONENT = 'PageEnvelope';

/** The component name for the ranked envelope. */
export const V1_RANKED_PAGE_ENVELOPE_COMPONENT = 'RankedPageEnvelope';

/**
 * The collections a service-positioned cursor is SCOPED to — the vocabulary
 * from `lib/api/v1/pagination.ts`, as a value the document can enumerate.
 *
 * Re-expressed here rather than re-typed: `V1_COLLECTIONS` stays the single
 * source (Amendment 3 Q1 made the scope load-bearing — an unscoped cursor would
 * decode cleanly into the wrong collection and return a silently wrong page), and
 * this is only its schema form.
 */
export const v1CollectionSchema = z.enum(V1_COLLECTIONS);

/**
 * The page cursor as it appears on the wire: an opaque, HMAC-signed token.
 *
 * Deliberately `z.string()` with no structure. §5's whole point is that a client
 * cannot construct one — describing the payload in the published document would
 * make the underlying sort key public API and turn a future index change into a
 * breaking change.
 */
export const v1CursorSchema = z.string().min(1);
