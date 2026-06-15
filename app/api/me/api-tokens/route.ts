import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { InvalidApiTokenLabelError } from '@/lib/apiTokens/errors';
import { NotAMemberError } from '@/lib/workspaces/errors';

// /api/me/api-tokens (Story 7.8 · Subtask 7.8.3) — the current user's API tokens
// (the MCP bearer credentials, 7.8.1). Account-level: the GET lists ALL the
// user's tokens across their workspaces (each labelled with the org → workspace
// it is bound to), and the POST mints a token BOUND to a workspace the caller
// CHOOSES in the create modal (bug 7.21 — defaults to the active workspace, but
// any workspace the user belongs to is selectable). So the gate is `getSession`
// (account-level); the chosen `workspaceId` rides the POST body and the service
// asserts membership.
//
// Deliberately COOKIE-SESSION ONLY (never PAT-authed): the PAT is for agents,
// but the surface that MINTS a PAT must not be reachable WITH a PAT, so a leaked
// token cannot mint more tokens. The MCP bearer gate (7.8.4) lives at /api/mcp;
// it never routes here.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.
//   GET  → 200 { tokens: ApiTokenDto[] }
//   POST { label, expiresInDays, workspaceId } → 201 { token, dto }
//     — `token` is the FULL plaintext secret, returned ONCE; the client shows it
//     once with a copy affordance and it is then irretrievable. A `workspaceId`
//     the caller is not a member of → 403.

/** The expiry options the 7.8.2 settings select offers (30 / 90 / 365 days, or
 * `null` for never). The route validates against this exact set so an arbitrary
 * horizon can't be smuggled in, then derives the absolute `expiresAt` the
 * service stores (the 7.8.1 service documents that the UI derives it). */
const ALLOWED_EXPIRY_DAYS = new Set([30, 90, 365]);
const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const tokens = await apiTokensService.listForUser(session.user.id);
  return NextResponse.json({ tokens });
}

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { label, expiresInDays, workspaceId } = (body ?? {}) as {
    label?: unknown;
    expiresInDays?: unknown;
    workspaceId?: unknown;
  };

  if (typeof label !== 'string') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A token label is required.' },
      { status: 400 },
    );
  }

  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A workspaceId is required.' },
      { status: 400 },
    );
  }

  // `expiresInDays`: a member of ALLOWED_EXPIRY_DAYS, or null/absent for "never".
  let expiresAt: Date | null = null;
  if (expiresInDays !== null && expiresInDays !== undefined) {
    if (typeof expiresInDays !== 'number' || !ALLOWED_EXPIRY_DAYS.has(expiresInDays)) {
      return NextResponse.json(
        { code: 'BAD_REQUEST', error: 'expiresInDays must be 30, 90, 365, or null.' },
        { status: 400 },
      );
    }
    expiresAt = new Date(Date.now() + expiresInDays * DAY_MS);
  }

  try {
    const result = await apiTokensService.create(session.user.id, workspaceId, {
      label,
      expiresAt,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof InvalidApiTokenLabelError) {
      return NextResponse.json({ code: err.code }, { status: 422 });
    }
    // A workspace the caller is not a member of (or a forged id) — 404-not-403
    // would also be defensible, but the picker only offers the user's own
    // workspaces, so a mismatch is a forbidden action, not a hidden resource.
    if (err instanceof NotAMemberError) {
      return NextResponse.json({ code: 'WORKSPACE_FORBIDDEN' }, { status: 403 });
    }
    throw err;
  }
}
