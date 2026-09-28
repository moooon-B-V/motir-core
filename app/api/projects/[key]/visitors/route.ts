import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import { projectMemberErrorResponse } from '@/lib/projects/memberErrorResponse';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';

// GET /api/projects/[key]/visitors?cursor= (Story MOTIR-6170 · MOTIR-6667) — the
// next page of a public project's Visitors list, for its Managers (the Show more
// on Settings › Access & members). `project:manage_access` gated, and a project
// that is not Public answers the same 403 a reader without the key gets. Thin
// HTTP transport per CLAUDE.md: parse, one service call, map typed errors.

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
  const cursor = new URL(req.url).searchParams.get('cursor');

  try {
    const page = await visitorRecordsService.listForManagers({ key, ctx, cursor });
    return NextResponse.json(page);
  } catch (err) {
    const mapped = projectMemberErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
