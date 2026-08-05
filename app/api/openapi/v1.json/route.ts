import { NextResponse } from 'next/server';
import { emitOpenApiDocument } from '@/lib/api/v1/openapi/emit';

// GET /api/openapi/v1.json — the published OpenAPI 3.1 document
// (Story 11.4 · Subtask 11.4.4 — MOTIR-2185).
//
// ── Why HERE, and not `/api/v1/openapi.json` ────────────────────────────────
// ADR Amendment 4 Q3, and it is the one place in this story a planner
// recommendation was overturned by the check it asked for. Serving the spec
// inside `app/api/v1` would collide with the shipped route audit
// (`tests/helpers/v1RouteAudit.ts` walks every `route.ts` under that root and
// raises `bypasses-wrapper` for a handler not wrapped in `withV1Route`, and the
// wrapper authenticates) — so it would have required a named exemption, i.e. a
// hole in a security guard, cut for a documentation file. Rung 1 does not ask
// for that price: Gitea serves its spec at the instance ROOT (`/swagger.v1.json`)
// and GitLab publishes its document on a docs property, neither inside its
// authenticated versioned API tree.
//
// Outside that root the guard simply never sees this file, so it keeps its
// current unconditional form and there is no exemption for a future reader to
// widen. The dotted final segment is the App Router's own idiom for a route
// handler serving a named file.
//
// ── This route is DELIBERATELY not a v1 route ───────────────────────────────
// It does NOT compose `withV1Route`, and that is the point rather than an
// oversight: a specification is public documentation, and documentation a
// prospective integrator cannot fetch before signing up is not published. It
// therefore authenticates nothing, reads no database, spends no rate-limit
// budget and takes NO user input — it serializes a value assembled from
// compile-time declarations. Those four properties are what make an
// unauthenticated handler safe here, and `tests/api/v1/openapi-spec-route.test.ts`
// asserts each of them against this file's source rather than trusting the
// comment.
//
// ⚠️ The URL is PUBLIC API under ADR §8 the moment it ships. It may gain a
// sibling (`/api/openapi/v2.json`, Amendment 4 Q6) but it never moves while `v1`
// lives — a client generator hard-codes it.

/** The document is assembled from compile-time declarations; nothing per-request. */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return NextResponse.json(emitOpenApiDocument(), {
    headers: {
      // `application/json` rather than the `application/openapi+json` some tools
      // prefer: every generator accepts JSON, not every one accepts the vendor
      // type, and a spec nothing can fetch is worse documented than one with a
      // generic content type.
      'content-type': 'application/json; charset=utf-8',
      // Cacheable, because it changes only when the code does. `must-revalidate`
      // keeps a stale copy from outliving a deploy silently.
      'cache-control': 'public, max-age=300, must-revalidate',
    },
  });
}
