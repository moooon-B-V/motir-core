import { NextResponse } from 'next/server';
import { getWorkspaceContext } from '@/lib/workspaces';
import { triageService, type TriageSubmissionKind } from '@/lib/services/triageService';
import { mapTriageSubmissionError } from '@/lib/triage/errorResponse';

// POST /api/projects/[key]/triage/submissions (Story 6.11 · Subtask 6.11.4) —
// the in-app "report a bug / request a feature" intake. A signed-in workspace
// member submits a triage item; it is born a `work_item` (kind `bug` or `task`)
// in the `triage` state, EXCLUDED from every normal read (tree / board / list /
// ready / search) until an admin promotes it from the inbox (6.11.5).
//
// `[key]` is the project identifier ("PROD"), resolved within the actor's
// workspace — a cross-tenant / non-browsable key reads as 404 (no existence
// leak). A LOGGED-OUT caller is rejected 401 and creates nothing (intake is
// signed-in only — the unauthenticated public portal is dropped, Yue
// 2026-06-14). Story 6.12's public-project "Submit a request" reuses the SAME
// `triageService.createSubmission` authority via its own route + grant.
//
// POST → 201 { id, kind, identifier, title }

export async function POST(
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
    const result = await triageService.createSubmission(
      {
        projectKey: key,
        // The service validates `kind` is one of the request-grammar kinds
        // (`bug` / `task`) and throws a typed 422 otherwise — the cast only
        // narrows the parsed string for the call site.
        kind: b.kind as TriageSubmissionKind,
        title: b.title,
        descriptionMd: typeof b.descriptionMd === 'string' ? b.descriptionMd : null,
      },
      ctx,
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const mapped = mapTriageSubmissionError(err);
    if (mapped) return mapped;
    throw err;
  }
}
