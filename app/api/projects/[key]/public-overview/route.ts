import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// The public OVERVIEW's write door (MOTIR-4114 · `public-surface-hosts.md`
// AMENDMENT 3 row 7).
//
// ── ⚠️ THIS IS AN APPLICATION ROUTE, NOT A PUBLIC ONE, AND THAT IS THE POINT ─
//
// AMENDMENT 3 routes in-place overview editing as ABSENT from `motir.co`: the
// public page shows no edit affordance, because a cross-origin page cannot know
// who is looking, and because an overview edit is a long-form authoring act with
// a preview and a save — routing that through a link-out-and-return is worse
// than putting it where the author already signs in. Making it absent DELETES A
// WRITE PATH from the public origin, which is a positive choice rather than a
// concession.
//
// So the door lives here, under `/api/projects/*`, behind the application's own
// session — NOT under `/api/public/*`. It is deliberately not in the public
// contract: no consumer of that document can call it, and declaring an operation
// nobody outside this origin can invoke would document a capability that does
// not exist.
//
// ── ⚠️ WHY THE SERVICE METHOD NEEDED A DOOR AT ALL ────────────────────────
//
// `publicProjectsService.setPublicOverview` (and its real-database test) survived
// MOTIR-3951; the ONLY thing that called it — the deleted
// `app/(public)/p/[identifier]/overview-actions.ts` Server Action — did not. It
// has been a tested, admin-gated, transaction-owning method with no caller ever
// since, which compiles and passes for ever while the capability is simply gone.
//
// It is NOT the same entry point as the settings-area author. That one
// (`projectsService.setPublicOverview`, via the settings action) keys off the
// ACTIVE-PROJECT cookie; this one keys off the project's own key, because an
// admin can be looking at one project's public overview while a different
// project is active. Its own docstring says exactly that, and it is why both
// exist.
//
// ── The gate is the SERVICE's, and it is doubled ──────────────────────────
//
// This route reads a session and passes the actor down. It asserts nothing
// itself: `publicProjectsService.setPublicOverview` refuses a non-admin with
// `NotProjectAdminError` BEFORE any write, and the delegate re-runs
// `assertCanManage` inside the write transaction. An anonymous caller never
// resolves `canManage`, so a null actor 403s on the same path — which is why
// there is no separate 401 arm here and no route-level admin check to drift.
//
// Cloud-gated, because the capability it edits is: a self-hosted build has no
// public projects, so it has no public overview to author (§5).
//
// HTTP layer only: gate → session → parse → one service call → error mapping.

interface Body {
  publicOverviewMd?: unknown;
  publicTagline?: unknown;
  publicTags?: unknown;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST, before any session read.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { key } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let body: Body;
  try {
    body = ((await req.json()) ?? {}) as Body;
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  // A PARTIAL author: each field is optional and an absent one is UNTOUCHED,
  // which is the service's own contract. So the shape check has to distinguish
  // "absent" from "present and wrong" — passing `undefined` for a malformed
  // value would silently drop an edit the caller believes they made.
  if (body.publicOverviewMd !== undefined && typeof body.publicOverviewMd !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`publicOverviewMd` must be a string.' },
      { status: 400 },
    );
  }
  if (
    body.publicTagline !== undefined &&
    body.publicTagline !== null &&
    typeof body.publicTagline !== 'string'
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`publicTagline` must be a string or null.' },
      { status: 400 },
    );
  }
  if (
    body.publicTags !== undefined &&
    (!Array.isArray(body.publicTags) || body.publicTags.some((t) => typeof t !== 'string'))
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`publicTags` must be an array of strings.' },
      { status: 400 },
    );
  }

  try {
    await publicProjectsService.setPublicOverview(key, actorUserId, {
      ...(body.publicOverviewMd === undefined
        ? {}
        : { publicOverviewMd: body.publicOverviewMd as string }),
      ...(body.publicTagline === undefined
        ? {}
        : { publicTagline: body.publicTagline as string | null }),
      ...(body.publicTags === undefined ? {} : { publicTags: body.publicTags as string[] }),
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    // The shared project error mapper — `NotProjectAdminError` → 403,
    // `ProjectNotFoundError` → 404, the three field errors → 400/422 — so this
    // route and every other project route answer a given failure identically.
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
