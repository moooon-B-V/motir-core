import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { ImpersonationCredentialRefusedError } from '@/lib/platform/errors';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';
import { OAuthConsentRequestInvalidError } from '@/lib/oauth/errors';
import { InvalidTokenGrantError } from '@/lib/apiTokens/errors';
import { WorkspaceNotFoundError } from '@/lib/workspaces/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// POST /api/oauth/consent (Story MOTIR-6973 · Subtask MOTIR-6985) — the consent
// screen's two buttons. HTTP only (CLAUDE.md): parse → one service call →
// typed error → status.
//
//   { action: 'approve', oauthQuery, workspaceId, projectId?, permissions? }
//     → 200 { connectionId, redirectUrl } — the client's redirect with the code.
//   { action: 'deny', oauthQuery }
//     → 200 { redirectUrl } — the client's redirect with `error=access_denied`.
//
// `oauthQuery` is the consent page's query exactly as the provider signed it;
// the service verifies the signature before it trusts a byte of it. Cookie
// session only: a PAT must never be able to connect an app on someone's behalf.
//
//   400 OAUTH_CONSENT_REQUEST_INVALID (+ `reason`) — forged, expired, unknown app
//   404 — a workspace or project the person cannot reach (never 403)
//   422 API_TOKEN_INVALID_PERMISSION — a grant beyond what they can confer there

function bad(error: string): Response {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('Expected a JSON body.');
  }
  const { action, oauthQuery, workspaceId, projectId, permissions } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof oauthQuery !== 'string' || oauthQuery.length === 0) {
    return bad('oauthQuery is required.');
  }
  const headers = new Headers(req.headers);

  try {
    if (action === 'deny') {
      return NextResponse.json(await oauthConnectionsService.denyConsent({ headers, oauthQuery }));
    }
    if (action !== 'approve') return bad("action must be 'approve' or 'deny'.");
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return bad('A workspaceId is required.');
    }
    if (
      projectId !== undefined &&
      projectId !== null &&
      (typeof projectId !== 'string' || projectId.length === 0)
    ) {
      return bad('projectId must be a non-empty string or null.');
    }
    if (
      permissions !== undefined &&
      !(Array.isArray(permissions) && permissions.every((p) => typeof p === 'string'))
    ) {
      return bad('permissions must be an array of strings.');
    }
    const result = await oauthConnectionsService.approveConsent({
      userId: session.user.id,
      headers,
      oauthQuery,
      workspaceId,
      projectId: (projectId as string | null | undefined) ?? null,
      ...(permissions !== undefined ? { permissions: permissions as string[] } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    // A credential cannot be minted inside a staff "View as" session (MOTIR-749).
    if (err instanceof ImpersonationCredentialRefusedError) {
      return NextResponse.json({ code: err.code }, { status: 403 });
    }
    if (err instanceof OAuthConsentRequestInvalidError) {
      return NextResponse.json({ code: err.code, reason: err.reason }, { status: 400 });
    }
    if (err instanceof WorkspaceNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    if (err instanceof InvalidTokenGrantError) {
      return NextResponse.json({ code: err.code }, { status: 422 });
    }
    throw err;
  }
}
