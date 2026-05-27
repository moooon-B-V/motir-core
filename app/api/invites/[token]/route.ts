import { NextResponse } from 'next/server';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';

// GET /api/invites/[token]
// Thin HTTP transport. The service returns either a DTO or null —
// null becomes 404 INVITE_EXPIRED_OR_MISSING.

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const { token } = await params;
  const result = await workspaceInvitesService.validateInvite(token);
  if (!result) {
    return NextResponse.json(
      { error: 'Invite is expired or no longer valid', code: 'INVITE_EXPIRED_OR_MISSING' },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
