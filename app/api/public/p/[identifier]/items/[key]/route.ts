import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicWorkItemNotFoundError } from '@/lib/publicProjects/errors';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// ONE WORK ITEM, as the public surface shows it (MOTIR-4110) — the read behind
// `/p/<identifier>/items/<key>`, the page a visitor lands on from an items-list
// row, a board card, or a link somebody shared.
//
// ── ⚠️ WHAT `[key]` ACTUALLY IS, read off the SERVICE and not off the old URL ─
//
// `getWorkItemDetail(identifier, itemIdentifier, actorUserId)` takes the full
// WORK-ITEM IDENTIFIER — `ACME-42`, the string — and resolves it inside the
// already-resolved public project (`workItemRepository.findByIdentifier`). It
// does NOT take the bare number, and it does NOT take an id.
//
// The deleted page's URL segment was called `[key]` and the DTO's `key` field is
// the bare NUMBER (`ACME-**42**`), so the segment name and the field of that name
// mean different things. This route keeps the segment name — it is the address
// people have — and passes its value through as the identifier the service asks
// for. A route that "helpfully" reconstructed `${identifier}-${key}` would break
// the moment a project key contains a dash.
//
// ── Posture: anonymous, and 404-not-403 in FOUR distinct cases ─────────────
//
// NOT session-gated. The session resolves `actorUserId`, which the service uses
// for member-visibility only. All four not-found conditions answer the same
// bare `{ code }` 404 with no existence leak, and that sameness is the point:
// an unknown key, an item in another project, an ARCHIVED item, a TRIAGE item
// (whose public surface is the request detail beside this one, not this one),
// and a private epic's hidden descendant are indistinguishable from outside.
// `ProjectNotFoundError` covers the project half; `PublicWorkItemNotFoundError`
// the item half — two codes, because a consumer rendering a page needs to know
// whether to say "no such project" or "no such item", and neither reveals
// anything a caller could not already guess from the URL they typed.
//
// HTTP layer only: gate → session → one service call → map errors.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ identifier: string; key: string }> },
) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST, before the rate limit and before
  // any session read: with `MOTIR_CLOUD` unset this surface does not exist.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { identifier, key } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  try {
    const detail = await publicProjectsService.getWorkItemDetail(identifier, key, actorUserId);
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PublicWorkItemNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
