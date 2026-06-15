import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidRoadmapCursorError } from '@/lib/publicProjects/roadmapCursor';
import { PUBLIC_ROADMAP_BUCKET_KEYS, type PublicRoadmapBucketKey } from '@/lib/dto/publicProjects';

// Public roadmap per-column pagination endpoint (Story 6.12 · Subtask 6.12.7) —
// the "Load more" fetch behind one roadmap column (submitted / planned /
// in_progress / done). NOT session-gated on READ: a logged-out visitor / crawler
// pages a public project's roadmap (the page itself is fully public). The
// service runs the anonymous public-browse gate (a non-public / unknown project
// → ProjectNotFoundError → 404, no existence leak). HTTP layer only: parse →
// one service call → map errors.
//
//   GET ?bucket=<key>&cursor=<opaque>  → 200 { bucket, cards, nextCursor }
//   bad/missing bucket or malformed cursor → 400; non-public project → 404.

function isRoadmapBucketKey(value: string | null): value is PublicRoadmapBucketKey {
  return value !== null && (PUBLIC_ROADMAP_BUCKET_KEYS as readonly string[]).includes(value);
}

export async function GET(req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  const url = new URL(req.url);
  const bucket = url.searchParams.get('bucket');
  const cursor = url.searchParams.get('cursor');

  // The load-more fetch always carries a column + a cursor; reject a malformed
  // request before touching the service (HTTP-layer parsing).
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
