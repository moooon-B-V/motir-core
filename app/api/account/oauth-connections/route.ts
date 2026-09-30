import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';

// GET /api/account/oauth-connections (Story MOTIR-6973 · Subtask MOTIR-6986) —
// the signed-in person's OAuth connections, newest first: what Settings →
// Account → Connected apps lists, and what its Try again re-reads.
//
// Session-authed only (cookie), like `/api/me/api-tokens`: a bearer — a PAT or
// an OAuth access token — must never be able to enumerate, or revoke, the grants
// that mint bearers. The service reads under the person's own RLS context, so
// the list cannot contain anybody else's row.
export async function GET(): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const connections = await oauthConnectionsService.listForUser(gate.session.user.id);
  return NextResponse.json({ connections });
}
