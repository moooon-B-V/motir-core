import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// ONE FEATURE REQUEST, with its public comment thread and its vote count
// (MOTIR-4110) — the read behind `/p/<identifier>/requests/<requestKey>`.
//
// ── ⚠️ THIS RESOURCE IS ADDRESSED TWO WAYS, AND THE SPLIT IS DELIBERATE ────
//
// READ (here): `getRequestDetail(identifier, requestIdentifier, actorUserId)` —
// the project KEY plus the request's WORK-ITEM IDENTIFIER (`ACME-42`), because
// that is the address a person has: it is in the URL they were sent, and it is
// what the roadmap and items lists link to.
//
// WRITE (elsewhere): `POST /api/public/projects/{projectId}/requests` and
// `POST /api/public-requests/{id}/{upvote,comments}` take the GLOBAL project id
// and the work-item id. A write is issued by a client that has just READ the
// resource and therefore holds its id; a read is issued by whoever followed a
// link. Different callers, different identifiers, and the route that guesses is
// the one that breaks.
//
// So this route passes `requestKey` through as the identifier the service asks
// for. It does not parse it, reconstruct it, or look anything up first.
//
// ── This route is a READ, and it does not touch the writes ─────────────────
//
// The comment thread it returns is displayed here and POSTED elsewhere. What
// becomes of those writes once the page is cross-origin from the session is
// `public-surface-hosts.md` AMENDMENT 4's (rows 4 and 5: a hand-off), and
// MOTIR-4114 ships it. Nothing here changes them.
//
// ── Posture: anonymous, 404-not-403 ───────────────────────────────────────
//
// NOT session-gated. The session resolves `actorUserId`, which personalises
// `voted` and applies member-visibility — anonymously `voted` is always false,
// which after AMENDMENT 4 is the only state `motir.co` can produce. A missing,
// cross-project, archived or epic-privacy-hidden request answers the same bare
// `{ code }` 404 as a non-public project.
//
// HTTP layer only: gate → session → one service call → map errors.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ identifier: string; requestKey: string }> },
) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST, before the rate limit and before
  // any session read: with `MOTIR_CLOUD` unset this surface does not exist.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { identifier, requestKey } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  try {
    const detail = await publicProjectsService.getRequestDetail(
      identifier,
      requestKey,
      actorUserId,
    );
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PublicRequestNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
