import { z } from 'zod/v4';

// The v1 IDENTITY + WORKSPACE shapes (Story 11.4 · Subtask 11.4.5 — MOTIR-2186).
//
// ⚠️ WHY THIS MODULE EXISTS AT ALL, AND WHY IT IS 11.4's — a recorded plan gap.
//
// ADR Amendment 2 assigned the per-resource response schemas by STORY: 11.2 owns
// the work-item shapes, 11.3 owns projects / sprints / backlog / ready, and
// "11.4 … authors NO per-resource shape". Story 11.1's own two endpoints —
// `GET /api/v1/me` and `GET /api/v1/workspaces` — were shipped BEFORE that
// amendment was written and were never assigned to anyone, so they shape their
// rows inline in the route (correctly, and for the stated reason: "the response
// is shaped explicitly rather than spread, because `verify` returns the raw
// Prisma `User` row and a public API must never leak one").
//
// Declaring an operation for them requires a schema, and no schema exists. The
// alternatives were to leave two shipped endpoints out of the published document
// — the exact "a reference that covers some of an API" failure this card exists
// to close — or to declare them here. This is the second, and the gap in
// Amendment 2's split is filed as a planning bug against Story 11.1 rather than
// papered over: MOTIR-2195, which decides this module's long-term home, whether
// the two routes should MAP through it, and amends Amendment 2 so its split is
// total.
//
// ── These schemas DESCRIBE; they do not change the routes ───────────────────
// Neither route imports this module, and neither route changes: 11.4.5's scope
// boundary says "the declaration follows the route", not the reverse. The
// schemas are proven honest by `tests/api/v1/openapi-operations-coverage.test.ts`,
// which drives the REAL routes with a REAL token and parses what they actually
// return — not a fixture written from the same assumption as the schema.

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
