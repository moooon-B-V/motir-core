import { z } from 'zod/v4';

// The v1 IDENTITY + WORKSPACE shapes — Story 11.1's, per ADR Amendment 5
// (MOTIR-2195). Written by Subtask 11.4.5 (MOTIR-2186); OWNED by Story 11.1.
//
// ⚠️ WHY THE AUTHOR AND THE OWNER DIFFER — a plan gap, now closed.
//
// ADR Amendment 2 assigned the per-resource response schemas by STORY: 11.2 owns
// the work-item shapes, 11.3 owns projects / sprints / backlog / ready, and
// "11.4 … authors NO per-resource shape". Story 11.1's own two endpoints —
// `GET /api/v1/me` and `GET /api/v1/workspaces` — shipped BEFORE that amendment
// was written and appeared in none of its three sentences, so declaring an
// OpenAPI operation for them found no schema to declare from. 11.4.5 authored
// them here rather than leave two shipped endpoints out of the published
// document, and filed the gap as MOTIR-2195.
//
// **ADR Amendment 5 (2026-08-05) settled it:** this module is where the shapes
// belong, and they are **Story 11.1's** — Amendment 2's ownership list now names
// 11.1 alongside 11.2 and 11.3, and 11.4's "authors no per-resource shape"
// boundary is intact because the one shape it authored was transferred here
// rather than excused. Amendment 5 also pins how the split is CHECKED (walk
// `app/api/v1`, never re-read the sentences) and what to do with a future
// endpoint that arrives without an owner: declare it in its resource's own
// module and file a card against the owning story.
//
// ── These schemas DESCRIBE today; they will EMIT ────────────────────────────
// Neither route imports this module yet: 11.4.5's scope boundary said "the
// declaration follows the route", not the reverse. Amendment 5 decided the two
// routes SHOULD map through the schema the way every other v1 resource does
// (`presentProject`, `presentWorkItemDetail`) — a response-shaping code change,
// so it ships as its own card with its own PR: MOTIR-2202 (11.1.7). Until that
// lands, the schemas are proven honest by
// `tests/api/v1/openapi-operations-coverage.test.ts`, which drives the REAL
// routes with a REAL token and parses what they actually return — not a fixture
// written from the same assumption as the schema.

/**
 * `GET /api/v1/me` — who this token is, and what it may do.
 *
 * Three fields on `user` and no more. The route's own comment records why:
 * `verify` returns the raw Prisma `User` row, so `emailVerified`, `image`,
 * the timestamps and whatever a later migration adds would all become public
 * contract by accident.
 */
export const meSchema = z
  .object({
    user: z
      .object({
        /** The user's id. A user has no `MOTIR-<n>` key, so its id IS its name on the wire. */
        id: z.string(),
        name: z.string(),
        email: z.string(),
      })
      .strict(),
    /** The ONE workspace this token is bound to. v1 never widens past it. */
    workspaceId: z.string(),
    /**
     * The scopes this token was granted.
     *
     * Returned deliberately: it is how a client discovers what its own
     * credential may do without probing endpoints and collecting 403s.
     */
    scopes: z.array(z.string()),
  })
  .strict();

/** The identity payload, inferred from the schema. */
export type V1Me = z.infer<typeof meSchema>;

/**
 * One row of `GET /api/v1/workspaces`.
 *
 * ⚠️ Account-level, and the one place v1 answers outside the bound workspace:
 * the collection lists the workspaces the TOKEN OWNER belongs to, so a client
 * holding a fresh token can learn which workspace ids exist for it. It discloses
 * exactly what the owner already sees in their own workspace switcher.
 */
export const workspaceSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    createdAt: z.string(),
  })
  .strict();

/** One workspace row, inferred from the schema. */
export type V1WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
