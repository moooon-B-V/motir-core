import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { mapPublicProjectError } from '@/lib/publicProjects/errorResponse';

// GET /api/public/projects/[projectId]/requests/duplicates?title=… (Story 6.12
// · Subtask 6.12.5) — the duplicate-detection pre-check the public submit form
// calls as the user types a title. Returns the matching EXISTING active public
// requests so the UI can offer "upvote this instead" before a dupe is created
// (Canny's behaviour). Deterministic title match (no AI), bounded.
//
// Same gate as the submit (sign-in-to-act on a PUBLIC project): a LOGGED-OUT
// caller is 401, a non-public project is 404 (no existence leak). `[projectId]`
// is the global project id (ADR §2.2). A blank `title` returns no candidates.
//
// GET → 200 { candidates: [{ id, kind, identifier, title, status, voteCount }] }

export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { projectId } = await params;
  const title = new URL(req.url).searchParams.get('title') ?? '';

  try {
    const result = await publicProjectsService.findDuplicateRequests(
      projectId,
      session.user.id,
      title,
    );
    return NextResponse.json(result);
  } catch (err) {
    const mapped = mapPublicProjectError(err);
    if (mapped) return mapped;
    throw err;
  }
}
