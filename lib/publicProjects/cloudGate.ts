import { NextResponse } from 'next/server';
import { isCloud } from '@/lib/billing/availability';

// THE PUBLIC-SURFACE CAPABILITY GATE (Story MOTIR-3908 · MOTIR-4034).
//
// Build-in-public is a CLOUD feature. A self-hosted Motir is a team doing
// project management for itself — single-tenant, no directory of other people's
// projects, no reading surface for strangers. With `MOTIR_CLOUD` unset there is
// therefore no public-projects feature AT ALL: not a hidden page, an ABSENT
// capability.
//
// ── WHY 404, and not 403 or a "cloud only" page ────────────────────────────
//
// A 404 is a DECISION here, not a default. A 403 says *this exists and you may
// not see it*; a friendly "this is a Motir Cloud feature" page says the same
// thing in prose. Both are true statements about the hosted service and false
// statements about the build in front of the caller — on a self-host build
// there is nothing behind the door, so the honest answer is that there is no
// door. It is also the answer the surface already gives for a project that is
// not public (`ProjectNotFoundError` → 404, "deliberately indistinguishable
// from an unknown key"), so the gate does not introduce a second vocabulary for
// "not available here".
//
// ── The body is `{ code }`, the surface's own refusal shape ────────────────
//
// `lib/api/public/openapi/schemas.ts`'s `publicErrorSchema` is documented as
// "what every route on this surface returns on a refusal", so the gate answers
// in it. (MOTIR-4034's description proposed `{ error: 'Not found' }`; that would
// have made the gate the only refusal on the surface with its own shape, and the
// published contract declares otherwise. Amended on the card.)
//
// ── It runs FIRST, before anything else in the handler ─────────────────────
//
// Before the rate-limit guard and before the session read, on every route
// including the four that require a session. Two reasons: a capability that does
// not exist must not spend a per-IP rate-limit budget or open a session, and a
// 401 answered ahead of the gate would tell an anonymous caller that the route
// is there.
//
// ── One helper, so every gated route answers identically ───────────────────
//
// The consistency is by CONSTRUCTION rather than by convention. A route that
// forgets to call it is caught by `tests/api/public/cloud-gate-totality.test.ts`
// (MOTIR-4036), which enumerates the surface from the filesystem rather than
// from a list somebody has to remember to extend.

/** The refusal code, exported so tests assert the value rather than restate it. */
export const PUBLIC_SURFACE_ABSENT_CODE = 'NOT_FOUND';

/**
 * The gate. Returns the 404 to answer with on a self-hosted build, or `null`
 * when the caller may carry on.
 *
 * Used as the first statement of every `app/api/public/*` handler:
 *
 * ```ts
 * const absent = publicSurfaceUnavailable();
 * if (absent) return absent;
 * ```
 */
export function publicSurfaceUnavailable(): NextResponse | null {
  if (isCloud()) return null;
  return NextResponse.json({ code: PUBLIC_SURFACE_ABSENT_CODE }, { status: 404 });
}
