import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import {
  InvalidEmailError,
  InviteRateLimitedError,
  InviteTargetAlreadyMemberError,
  NotAMemberError,
} from '@/lib/workspaces/errors';

// POST /api/workspaces/[workspaceId]/invites
// Thin HTTP transport: parses the request, calls the service, maps
// typed domain errors to status codes. All business logic and DB
// access lives in workspaceInvitesService.

interface RouteParams {
  params: Promise<{ workspaceId: string }>;
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { workspaceId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const rawEmail =
    body && typeof body === 'object' && 'email' in body && typeof body.email === 'string'
      ? body.email
      : null;
  if (!rawEmail) {
    return NextResponse.json(
      { error: 'Missing "email" field', code: 'BAD_REQUEST' },
      { status: 400 },
    );
  }

  try {
    const result = await workspaceInvitesService.sendInvite({
      inviterUserId: session.user.id,
      inviterName: session.user.name,
      workspaceId,
      targetEmail: rawEmail,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InvalidEmailError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    if (err instanceof NotAMemberError) {
      // Cross-tenant access must NOT leak that this workspace exists. A 403
      // ("you're not a member") confirms the workspace is real; a 404
      // ("no such workspace") is indistinguishable from an id that never
      // existed, so an attacker probing for workspace ids learns nothing.
      // The 404 body mirrors the not-found shape used by
      // app/api/invites/[token]/route.ts so 404 responses stay consistent.
      return NextResponse.json(
        { error: 'Workspace not found', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    if (err instanceof InviteTargetAlreadyMemberError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    if (err instanceof InviteRateLimitedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 429 });
    }
    throw err;
  }
}
