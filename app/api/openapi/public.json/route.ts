import { NextResponse } from 'next/server';
import { emitPublicOpenApiDocument } from '@/lib/api/public/openapi/emit';

// GET /api/openapi/public.json — the published contract for the anonymous
// public read surface (MOTIR-3946).
//
// ── Why HERE, beside `v1.json` ──────────────────────────────────────────────
// The same reason that route gives for its own placement, and it is worth not
// re-deriving: serving a spec inside `app/api/v1` would collide with the route
// audit, which walks that root and raises `bypasses-wrapper` for a handler not
// wrapped in `withV1Route` — so it would need a named exemption, a hole cut in a
// security guard for a documentation file. Outside that root the guard never
// sees it. This document describes a different surface again, and belongs in the
// same neutral place.
//
// ── It is deliberately not a v1 route, and not a public-surface route ────────
// It composes no wrapper: there is nothing to authenticate and nothing to
// personalise. It is a static projection of a registry, which is why it needs no
// database and has nothing to go stale.

/** Assembled from compile-time declarations; nothing per-request. */
export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  return NextResponse.json(emitPublicOpenApiDocument(), {
    headers: {
      // `application/json`, not `application/openapi+json`: every generator
      // accepts JSON and not every one accepts the vendor type — `v1.json`'s
      // reasoning, and there is no reason for the two documents to be served
      // differently.
      'content-type': 'application/json; charset=utf-8',
      // Cacheable because it changes only when the code does; `must-revalidate`
      // keeps a stale copy from outliving a deploy silently.
      'cache-control': 'public, max-age=300, must-revalidate',
    },
  });
}
