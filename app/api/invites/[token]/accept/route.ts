import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { InviteEmailMismatchError, InviteExpiredOrMissingError } from '@/lib/workspaces/errors';

// POST /api/invites/[token]/accept
// Thin HTTP transport. The service owns atomicity (membership insert
// + token delete in one transaction) and idempotency.

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not signed in', code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { token } = await params;
  try {
    const result = await workspaceInvitesService.acceptInvite(token, {
      id: session.user.id,
      email: session.user.email,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof InviteExpiredOrMissingError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 404 });
    }
    if (err instanceof InviteEmailMismatchError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    }
    throw err;
  }
}
