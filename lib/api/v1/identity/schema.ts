import { z } from 'zod/v4';
import type { apiTokensService } from '@/lib/services/apiTokensService';
import type { workspacesService } from '@/lib/services/workspacesService';

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
// ── These schemas EMIT ──────────────────────────────────────────────────────
// Both routes MAP THROUGH this module (MOTIR-2202 / 11.1.7, closing Amendment
// 5 §4): `presentMe` and `presentWorkspaceSummary` below are the values
// `/api/v1/me` and `/api/v1/workspaces` return, exactly as every other v1
// resource emits `presentProject` / `presentWorkItemDetail`. The published
// document and the endpoint are now the SAME expression rather than two a test
// reports as equal — a field added here is a field the reference gains the same
// day, and a field added anywhere else cannot reach the wire at all.
//
// `tests/api/v1/openapi-operations-coverage.test.ts` still drives the REAL
// routes with a REAL token and parses what they actually return — not a fixture
// written from the same assumption as the schema. It is no longer the only
// thing holding the two sides together, but it is what proves the mapper is
// wired to the route rather than merely exported beside it.
//
// ⚠️ WHY EVERY MAPPER SHAPES FIELD BY FIELD AND NEVER SPREADS.
// The service layer hands these mappers RAW PRISMA ROWS — `apiTokensService.verify`
// returns a `User`, `workspacesService.listUserWorkspaces` returns `Workspace[]` —
// and a public API must never leak one. `emailVerified`, `image`, the timestamps
// and whatever a later migration adds would all become contract by accident.
// This reasoning used to live in each route handler; it lives HERE now, beside
// the field lists it governs, and each route keeps a one-line pointer to it. The
// mapper does not weaken that instinct — it institutionalises it, in ONE place
// instead of once per handler. (ADR Amendment 2's corollary is the same rule one
// level up: a v1 response IS a schema's output.)

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
 * What `apiTokensService.verify` resolves to — the mapper's input type, taken
 * FROM the service rather than restated beside it.
 *
 * Restating it would reintroduce exactly the defect this card removes, one
 * layer down: two shapes agreeing until someone edits one. Bound this way, a
 * service that renames `workspaceId` or stops returning `scopes` breaks the
 * build here, at the seam that decides what the public API says.
 */
type VerifiedToken = Awaited<ReturnType<typeof apiTokensService.verify>>;

/**
 * Map a verified token to the `/api/v1/me` payload — field by field, never a
 * spread (see the header's WHY note: `verified.user` is a raw Prisma `User`).
 *
 * Widening `User` therefore changes nothing on the wire. The three fields below
 * are the contract, and adding a fourth means editing this function — which is
 * the same edit that updates the published document.
 */
export function presentMe(verified: VerifiedToken): V1Me {
  return {
    user: {
      id: verified.user.id,
      name: verified.user.name,
      email: verified.user.email,
    },
    workspaceId: verified.workspaceId,
    scopes: verified.scopes,
  };
}

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

/**
 * One row of what `workspacesService.listUserWorkspaces` resolves to — the
 * mapper's input type, taken FROM the service for the reason `VerifiedToken`
 * records.
 */
type WorkspaceRow = Awaited<ReturnType<typeof workspacesService.listUserWorkspaces>>[number];

/**
 * Map a workspace row to its wire resource — field by field, never a spread
 * (see the header's WHY note: the service returns raw Prisma `Workspace` rows).
 *
 * `createdAt` is serialised HERE rather than left to `JSON.stringify`, so the
 * ISO string is the mapper's output type and not an accident of how the value
 * happens to be encoded. This is `paginateKeyset`'s row mapper, so the pager's
 * `(createdAt, id)` sort key stays internal — it sorts the Prisma row and emits
 * this shape.
 */
export function presentWorkspaceSummary(workspace: WorkspaceRow): V1WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    createdAt: workspace.createdAt.toISOString(),
  };
}
