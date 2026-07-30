import { NextResponse } from 'next/server';
import { cliDeviceService } from '@/lib/services/cliDeviceService';

// POST /api/cli/device/start (Story MOTIR-1863 · Subtask MOTIR-1865) — step 1 of
// `motir login`. The terminal asks for a grant; it gets the RFC 8628 §3.2 payload
// back and starts polling /api/cli/device/token.
//
// UNAUTHENTICATED BY DESIGN. A device grant is opened before anyone is identified —
// identifying the caller is what the browser approval does. Nothing is granted here:
// the response is a pair of codes that are worthless until a signed-in human
// approves them, and `client_id` is pinned server-side so the body cannot ask for a
// different client or a wider scope.
//
// `/api/cli/device/*` names the CLI-connect FLOW, not the caller — see
// docs/decisions/cli-login.md for why Motir owns these routes instead of exposing
// Better-Auth's /api/auth/device/* to the CLI.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.

export async function POST(req: Request): Promise<Response> {
  let body: unknown = {};
  if (req.headers.get('content-length') !== '0') {
    try {
      body = await req.json();
    } catch {
      // A bodyless start is legitimate — `hostname` is optional (the token label
      // falls back to "CLI · unknown host"), so an unparseable/absent body is not
      // worth a 400.
      body = {};
    }
  }
  const { hostname } = (body ?? {}) as { hostname?: unknown };

  const grant = await cliDeviceService.start({
    hostname: typeof hostname === 'string' ? hostname : null,
  });

  // no-store: the codes are single-use credentials-in-waiting (RFC 8628 §3.2).
  return NextResponse.json(grant, { headers: { 'Cache-Control': 'no-store' } });
}
