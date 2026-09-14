import { NextResponse } from 'next/server';
import { FolderNotFoundError } from '@/lib/folders/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { InvalidBugDestinationError } from '@/lib/projects/errors';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { projectsService } from '@/lib/services/projectsService';

// PATCH /api/projects/[key]/bug-destination (Story MOTIR-4927 · Subtask MOTIR-4938)
// — change where Motir files the bugs it creates on its own for this project
// (`Project.bugDestinationFolderId`). The writer is the destination card in
// `Project settings → Bugs`.
//
// Body: `{ "folderId": "<folder id>" }` for one of this project's folders, or
// `{ "folderId": null }` for the project root — a choice, not a clear. The
// response is the room's whole view (`BugDestinationDto`), so the card renders
// the write's own answer rather than re-reading.
//
// There is no GET: the room's page reads the value server-side through
// `bugDestinationService.getSettings`, and nothing else asks for it.
//
// Thin HTTP transport per CLAUDE.md: resolve the project by its key (a missing
// or unbrowsable project is a 404, never a 403), one service call, map typed
// errors. The authority is `project:administer`, asserted in the service.
//
// Typed errors → status codes:
//   InvalidBugDestinationError → 400  (neither a folder id nor null)
//   FolderNotFoundError        → 404  (no such folder, or ANOTHER project's)
//   ProjectNotFoundError       → 404  (no such project, or not a browser)
//   NotProjectAdminError       → 403  (lacks `project:administer`)

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const raw = (body ?? {}) as Record<string, unknown>;

  try {
    const project = await projectsService.getByKey(key, ctx);
    // The VALUE is validated by the service, which owns what a destination is.
    const result = await bugDestinationService.setDestination(project.id, raw.folderId, ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidBugDestinationError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof FolderNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
