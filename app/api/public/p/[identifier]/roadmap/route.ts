import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidRoadmapCursorError } from '@/lib/publicProjects/roadmapCursor';
import { PUBLIC_ROADMAP_BUCKET_KEYS, type PublicRoadmapBucketKey } from '@/lib/dto/publicProjects';
import { publicSurfaceUnavailable } from '@/lib/publicProjects/cloudGate';

// The public ROADMAP tab — TWO arms on one path, and the second one is new.
//
//   GET (no bucket, no cursor)          → 200 PublicRoadmapDto — the whole tab
//   GET ?bucket=<key>&cursor=<opaque>   → 200 { bucket, cards, nextCursor }
//
// ── Arm 2 is the shipped one (Story 6.12 · Subtask 6.12.7) ─────────────────
//
// The per-column "Load more" fetch behind one roadmap column (submitted /
// planned / in_progress / done). Its behaviour is UNCHANGED, deliberately and to
// the letter: an unknown bucket is still `INVALID_ROADMAP_BUCKET`, a bucket with
// no cursor is still `MISSING_ROADMAP_CURSOR`, a malformed cursor is still
// refused by the decoder — all 400. AMENDMENT 1 §D forbids changing the status
// an existing condition returns without a new MAJOR, and none of them moved.
//
// ── Arm 1 is MOTIR-4109's, and it is why the tab is renderable at all ──────
//
// `publicProjectsService.getRoadmap` returns the four columns with their first
// page each, and had NO route: the deleted `app/(public)/p/[identifier]/roadmap`
// page called it through Prisma, so a renderer in another repository could page
// a column it could never load. This adds the FIRST page beside the next ones.
//
// ⚠️ ONE PATH, NOT TWO. A second route (`…/roadmap/columns`) would give one
// resource two addresses and leave the shipped pagination contract to be
// re-declared. Extending this one keeps the resource whole, and the arms are
// disjoint by construction: BOTH parameters absent is the only new case, so no
// request that has a defined answer today gets a different one (the additive
// clause of AMENDMENT 1 §D — `bucket` and `cursor` are now optional, which is
// the direction §D permits; making an optional parameter required is the one it
// forbids).
//
// NOT session-gated on READ, both arms: a logged-out visitor or crawler reads a
// public project's roadmap. The session resolves `actorUserId`, which
// personalises `voted` on each card and applies member-visibility — anonymously
// every card reads `voted: false`, which after AMENDMENT 4 is the only state
// `motir.co` can produce. The service runs the anonymous public-browse gate (a
// non-public / unknown project → ProjectNotFoundError → 404, no existence leak).
//
// HTTP layer only: parse → one service call → map errors.

function isRoadmapBucketKey(value: string | null): value is PublicRoadmapBucketKey {
  return value !== null && (PUBLIC_ROADMAP_BUCKET_KEYS as readonly string[]).includes(value);
}

export async function GET(req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  // The CAPABILITY gate (MOTIR-4034) — FIRST, before the rate limit and before
  // any session read: with `MOTIR_CLOUD` unset this surface does not exist.
  const absent = publicSurfaceUnavailable();
  if (absent) return absent;

  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  const url = new URL(req.url);
  const bucket = url.searchParams.get('bucket');
  const cursor = url.searchParams.get('cursor');

  // ARM 1 — the whole tab. Chosen only when NEITHER parameter is present, so a
  // request carrying one of them still meets the refusal it meets today rather
  // than silently restarting at the top of the roadmap.
  if (bucket === null && cursor === null) {
    try {
      const roadmap = await publicProjectsService.getRoadmap(identifier, actorUserId);
      return NextResponse.json(roadmap);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return NextResponse.json({ code: err.code }, { status: 404 });
      }
      throw err;
    }
  }

  // ARM 2 — the load-more fetch, which always carries a column + a cursor;
  // reject a malformed request before touching the service (HTTP-layer parsing).
  if (!isRoadmapBucketKey(bucket)) {
    return NextResponse.json({ code: 'INVALID_ROADMAP_BUCKET' }, { status: 400 });
  }
  if (!cursor) {
    return NextResponse.json({ code: 'MISSING_ROADMAP_CURSOR' }, { status: 400 });
  }

  try {
    const page = await publicProjectsService.getRoadmapColumn(
      identifier,
      actorUserId,
      bucket,
      cursor,
    );
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    if (err instanceof InvalidRoadmapCursorError) {
      return NextResponse.json({ code: err.code }, { status: 400 });
    }
    throw err;
  }
}
