import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { ApiTokenNotFoundError } from '@/lib/apiTokens/errors';

// DELETE /api/me/api-tokens/[tokenId] (Story 7.8 · Subtask 7.8.3) — revoke one
// of the CURRENT user's own tokens, which DELETES the row (MOTIR-3546).
// Session-authed (cookie only, like the collection route — the mint surface is
// never PAT-reachable).
//
// Ownership is enforced in the service: revoking a token id that is missing OR
// owned by another user is an ApiTokenNotFoundError → 404 (the 404-not-403
// no-existence-leak contract — a cross-user id must not confirm the token
// exists). That is unchanged by the delete; the ownership probe still runs
// first, and RLS still narrows it to the owner.
//
// The response is 204 with NO body: the row is gone, so there is no DTO left to
// return. The client REMOVES the row from its own state (the
// inline-edit-no-tree-refresh contract — the island owns its state, no
// re-fetch), which is what it already did to flip the row; it now splices
// instead of replacing.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { tokenId } = await params;
  try {
    await apiTokensService.deleteToken(session.user.id, tokenId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof ApiTokenNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
