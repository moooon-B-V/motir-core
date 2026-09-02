import { NextResponse } from 'next/server';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// The public-project INDEX (MOTIR-4111) — the crawl enumeration `motir.co`'s
// sitemap is built from.
//
// ── ⚠️ WHY THIS IS NOT `/api/public/explore` ───────────────────────────────
//
// They enumerate the same projects and they are different reads for different
// readers. `explore` is the human directory: ranked (popular / trending /
// recent), carrying names, taglines, tags and demand stats, and paged in
// screenfuls. This is the MACHINE list: an identifier and a `<lastmod>`, in a
// stable order, paged in a size chosen for a walk rather than for a screen. A
// sitemap generator asking `explore` for its rows would page a ranked list whose
// order changes under it and discard nine tenths of every payload.
//
// ── The order is `id`, and that is the design ─────────────────────────────
//
// A sitemap generator walks EVERY page in sequence over a set that mutates while
// it walks. Ordering by `updatedAt` would reshuffle under that walk — a project
// edited between page one and page two moves to the head, pushing a row the
// crawler has already passed onto a page it has not reached — so a project gets
// enumerated twice, or skipped, and nothing reports it. `updatedAt` is still in
// every row; it is the `<lastmod>`, not the sort key. The service's own comment
// carries the rest.
//
// ── Posture ───────────────────────────────────────────────────────────────
//
// NO SESSION IS READ, and none could change the answer: every row is
// `accessLevel = 'public'` by the repository's own filter. Cross-workspace by
// design — this is the directory of every public project, regardless of tenant.
//
// `cursor` is opaque and echoes a previous page's `nextCursor`, exactly as the
// public work-items list does it. An unrecognised cursor is not an error here:
// it is a position past the tail, and the honest answer to "what comes after a
// row that no longer exists" is an empty page, not a 400.
//
// HTTP layer only: gate → parse → one service call.

export async function GET(req: Request) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST: with `MOTIR_CLOUD` unset this
  // surface does not exist.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const cursor = new URL(req.url).searchParams.get('cursor');

  const page = await publicProjectsService.listPublicIndex(cursor ?? undefined);
  return NextResponse.json(page, {
    headers: {
      // The same five-minute window the feed uses, for the same reason: a
      // crawler polls on its own schedule and the set changes when a customer
      // publishes a project. Cacheable at the edge because the response cannot
      // vary by viewer — there is no session in it to vary on.
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
    },
  });
}
