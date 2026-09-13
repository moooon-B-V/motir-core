import { NextResponse } from 'next/server';
import { projectsService } from '@/lib/services/projectsService';
import { projectPrMergeModeService } from '@/lib/services/projectPrMergeModeService';
import {
  InvalidPrMergeModeError,
  PermissionDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// PATCH /api/projects/[key]/pr-merge-mode (Story MOTIR-4880 · Subtask MOTIR-5181)
// — change how this project MERGES its pull requests (`Project.prMergeMode`,
// `docs/decisions/approval-gates.md` §7). The writer is the merge-mode card in
// `Project settings → Approvals`.
//
// There is no GET: the room's page reads the value server-side through
// `projectPrMergeModeService.getPrMergeMode`, and nothing else asks for it.
//
// The project is addressed by its workspace-unique `key`, resolved through
// `projectsService.getByKey` (a missing or unbrowsable project is a 404, never a
// 403). Thin HTTP transport per CLAUDE.md: resolve, one service call, map typed
// errors. The authority is `workflow:manage`, asserted in the service — the room
// is manage-only (`docs/decisions/permission-inventory.md` R65), and this route
// is reachable by URL whatever the rail offers.
//
// Typed errors → status codes:
//   InvalidPrMergeModeError → 400  (not `auto` or `manual`)
//   ProjectNotFoundError    → 404  (no such project, or not a browser)
//   PermissionDeniedError   → 403  (lacks `workflow:manage`)

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
    // The VALUE is validated by the service, which owns the vocabulary.
    const result = await projectPrMergeModeService.setPrMergeMode(project.id, raw.prMergeMode, ctx);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidPrMergeModeError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PermissionDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message, permission: err.permission },
        { status: 403 },
      );
    }
    throw err;
  }
}
