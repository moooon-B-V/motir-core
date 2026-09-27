import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// GET /api/projects/[key]/access/preview?mode=<workspace|members|public>
// (Story MOTIR-6169 · MOTIR-6544) — the people who would LOSE entry if the project
// switched to `mode`: for `members`, every Full-scope, non-Manager workspace
// member who was not added; for any other mode, `[]`. It feeds the Members-only
// confirm on the Access & members page (MOTIR-6540 panel A2). Behind
// `project:manage_access`, the same key as the write. A read — nothing is locked
// and nothing changes. Thin HTTP transport per CLAUDE.md.

interface RouteParams {
  params: Promise<{ key: string }>;
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const hold = await refuseIfNonCompliant(ctx.userId);
  if (hold) return hold;

  const { key } = await params;
  const mode = new URL(req.url).searchParams.get('mode');
  if (!mode) {
    return NextResponse.json(
      { error: 'A "mode" query parameter is required.', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const losing = await projectMembersService.previewAccessModeChange({
      key,
      actorUserId: ctx.userId,
      ctx,
      mode,
    });
    return NextResponse.json({ losing });
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
