import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { ApiTokenNotFoundError } from '@/lib/apiTokens/errors';

// DELETE /api/me/api-tokens/[tokenId] (Story 7.8 · Subtask 7.8.3) — soft-revoke
// one of the CURRENT user's own tokens. Session-authed (cookie only, like the
// collection route — the mint surface is never PAT-reachable).
//
// Ownership is enforced in the service: revoking a token id that is missing OR
// owned by another user is an ApiTokenNotFoundError → 404 (the 404-not-403
// no-existence-leak contract — a cross-user id must not confirm the token
// exists). The response carries the updated DTO so the client flips the row to
// the muted "Revoked" state from the response (the inline-edit-no-tree-refresh
// contract — the island owns its state, no re-fetch).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { tokenId } = await params;
  try {
    const token = await apiTokensService.revoke(session.user.id, tokenId);
    return NextResponse.json({ token });
  } catch (err) {
    if (err instanceof ApiTokenNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
