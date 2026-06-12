import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectsService } from '@/lib/services/projectsService';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';

// DELETE /api/projects/[key]/aliases/[alias] (Story 6.8 · Subtask 6.8.1)
// Release a retired project key (the Jira Cloud "Previous project keys" remove):
// deletes the project's alias row for `[alias]`, un-reserving the key for other
// projects and breaking its old links (they 404 thereafter — the verified mirror
// consequence). Project-admin gated (in the service). A key that is not one of
// THIS project's aliases → AliasNotFoundError → 404. The per-alias sub-resource
// in the path addresses the target unambiguously (same shape as
// members/[userId]). Thin HTTP transport per CLAUDE.md.

interface RouteParams {
  params: Promise<{ key: string; alias: string }>;
}

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const { key, alias } = await params;

  try {
    const project = await projectsService.releaseAlias({ key, alias, ctx });
    return NextResponse.json({ project });
  } catch (err) {
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
