import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import type { TriageSubmissionKind } from '@/lib/services/triageService';
import { mapPublicProjectError } from '@/lib/publicProjects/errorResponse';

// POST /api/public/projects/[projectId]/requests (Story 6.12 · Subtask 6.12.5)
// — the cross-account public "submit a request" intake. ANY signed-in account
// (cross-org included) submits a bug/feature request into a PUBLIC project's
// 6.11 triage; the request is born a `work_item` in the `triage` state,
// EXCLUDED from every normal read until an admin promotes it.
//
// `[projectId]` is the GLOBAL project id (a public project is addressed by id,
// not the workspace-scoped "PROD" identifier — ADR §2.2). A LOGGED-OUT caller
// is rejected 401 (sign-in-to-act — reading a public project is anonymous, but
// every WRITE needs an account); a non-public project reads as 404 (no
// existence leak). Rate-limited + size-capped (an internet-facing write).
//
// POST → 201 { id, kind, identifier, title }

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { projectId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.kind !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`kind` is required.' },
      { status: 400 },
    );
  }
  if (typeof b.title !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`title` is required.' },
      { status: 400 },
    );
  }
  if (
    b.descriptionMd !== undefined &&
    b.descriptionMd !== null &&
    typeof b.descriptionMd !== 'string'
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`descriptionMd` must be a string.' },
      { status: 400 },
    );
  }

  try {
    const result = await publicProjectsService.submitPublicRequest(projectId, session.user.id, {
      // The service validates `kind` is one of the request-grammar kinds
      // (`bug` / `task`) and throws a typed 422 otherwise — the cast only
      // narrows the parsed string for the call site.
      kind: b.kind as TriageSubmissionKind,
      title: b.title,
      descriptionMd: typeof b.descriptionMd === 'string' ? b.descriptionMd : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const mapped = mapPublicProjectError(err);
    if (mapped) return mapped;
    throw err;
  }
}
