import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';

// GET /api/projects/[key]/lessons (Subtask MOTIR-3337 · Story MOTIR-3329)
// One page of the project's own lesson library — what its AI planner learned
// from its own planning work — for the AI-planning settings surface.
//
// Thin transport per CLAUDE.md: read the session context, resolve the project by
// its workspace-unique key, call ONE service method, map typed errors.
//
// ⚠️ The permission is checked INSIDE the service, BEFORE it calls motir-ai —
// not here and not after the fetch. A caller without `lesson:view` causes no
// upstream call at all, so the payload is never assembled for someone who may
// not read it (`projectLessonsService`, and the call-count assertion in
// `tests/ai/projectLessons.test.ts`).
//
// Typed errors → status codes (via the shared `projectErrorResponse`):
//   ProjectNotFoundError  → 404 (missing / cross-tenant / non-browsable — a
//                                project a viewer cannot see must look missing)
//   PermissionDeniedError → 403 (`lesson:view`; the body carries the key)
//
// A motir-ai OUTAGE is not an error here: the service returns
// `{ available: false, lessons: [] }` and this route answers 200 with it, so an
// unrelated outage costs the section its content and not the page.

interface RouteParams {
  params: Promise<{ key: string }>;
}

// The paging cap is motir-ai's (`ADMIN_PAGE_MAX`), asserted upstream. This one
// only refuses a value that is not a page size at all, so a typo is a 400 here
// rather than a silent clamp two services away.
function parseLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return NaN;
  return n;
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  const { key } = await params;

  const url = new URL(req.url);
  const limit = parseLimit(url.searchParams.get('limit'));
  if (Number.isNaN(limit)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`limit` must be a positive integer.' },
      { status: 400 },
    );
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    const page = await projectLessonsService.listLessons(project.id, ctx, {
      cursor: url.searchParams.get('cursor') ?? undefined,
      limit,
    });
    return NextResponse.json(page);
  } catch (err) {
    const res = projectErrorResponse(err);
    if (res) return res;
    throw err;
  }
}
