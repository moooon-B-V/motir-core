import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { projectTagsService } from '@/lib/services/projectTagsService';
import { mapProjectTagError } from '@/lib/projectTags/errorResponse';

// GET/PUT /api/projects/[key]/tags (Story 6.13 · Subtask 6.13.5) — a project's
// topic tags (the GitHub-Topics axis the public square browses by). Thin HTTP
// layer over projectTagsService; no db / no transaction here (CLAUDE.md). `[key]`
// is the project identifier ("PROD"), resolved within the actor's workspace — a
// cross-tenant key reads as 404 (no existence leak), as does a non-browsable
// project.
//
// GET                 → 200 { tags: ProjectTagDto[] }      (browse-gated)
// PUT  { slugs: [] }   → 200 { tags: ProjectTagDto[] }      (project-admin-gated,
//   the 6.4 two-tier check) — an idempotent full REPLACE of the project's tags.
//
// Typed errors → status codes (see lib/projectTags/errorResponse.ts).

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { key } = await params;

  try {
    const tags = await projectTagsService.getProjectTags(key, ctx);
    return NextResponse.json({ tags });
  } catch (err) {
    const mapped = mapProjectTagError(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

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

  const { slugs } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(slugs) || !slugs.every((s) => typeof s === 'string')) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`slugs` must be an array of strings.' },
      { status: 400 },
    );
  }

  try {
    const tags = await projectTagsService.setProjectTags(key, slugs, ctx);
    return NextResponse.json({ tags });
  } catch (err) {
    const mapped = mapProjectTagError(err);
    if (mapped) return mapped;
    throw err;
  }
}
