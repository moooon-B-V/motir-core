import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidChangelogCursorError } from '@/lib/publicProjects/changelogCursor';

// Public CHANGELOG pagination endpoint (Story 8.9 · Subtask 8.9.4) — the "Load
// more" fetch behind the Changelog tab. The same shape as the Work items and
// Roadmap endpoints beside it: NOT session-gated on READ (a logged-out visitor
// or a crawler pages a public project), the service runs the anonymous
// public-browse gate, and a non-public / unknown project throws
// ProjectNotFoundError → 404 with no existence leak. HTTP layer only: parse →
// one service call → map errors.
//
// The one error this route adds to that shape is the CURSOR. A malformed token
// answers 400 rather than silently restarting from the top: a pager that
// repeats its first page for ever is far harder to notice than an error, and
// the decoder validates every field precisely so it can be an error here (see
// `changelogCursor.ts`).

export async function GET(req: Request, { params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;
  const cursor = new URL(req.url).searchParams.get('cursor') ?? undefined;

  try {
    const page = await publicProjectsService.getChangelog(identifier, actorUserId, cursor);
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    if (err instanceof InvalidChangelogCursorError) {
      return NextResponse.json({ code: err.code }, { status: 400 });
    }
    throw err;
  }
}
