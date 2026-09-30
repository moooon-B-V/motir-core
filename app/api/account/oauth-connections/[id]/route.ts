import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';
import { OAuthConnectionNotFoundError } from '@/lib/oauth/errors';

// DELETE /api/account/oauth-connections/[id] (Story MOTIR-6973 · Subtask
// MOTIR-6986) — revoke one of the signed-in person's connections. The service
// deletes the grant and, by cascade, every access and refresh token issued under
// it, so the app's next MCP call is a 401.
//
// An id that is missing, another person's, a PAT's, or already revoked is a 404
// (the 404-not-403 no-existence-leak contract). It is an expected answer, so it
// logs nothing: the Connected apps island treats it as success, because the
// person's intent — that app cannot act — holds either way.
//
// 204 with no body: the row is gone, and the island splices it out itself.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;

  const { id } = await params;
  try {
    await oauthConnectionsService.revoke(gate.session.user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof OAuthConnectionNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}
