import { NextResponse } from 'next/server';
import { cliDeviceService } from '@/lib/services/cliDeviceService';
import { DeviceGrantError, DeviceGrantUnboundError } from '@/lib/cliDevice/errors';

// POST /api/cli/device/token (Story MOTIR-1863 · Subtask MOTIR-1865) — the CLI's
// poll, and the ONE seam where Motir's two credential systems meet: a browser session
// authorized this grant, and here it becomes a `motir_pat_…` bearer. A session never
// becomes a bearer anywhere else.
//
// UNAUTHENTICATED, and it must be: the caller is a terminal that has no credential
// yet. The `device_code` IS the authentication — 40 chars of entropy that only the
// requesting process holds — and it buys nothing until a human approves the grant.
//
// THE ERROR SHAPE IS RFC 8628 §3.5, NOT MOTIR'S. Every state is HTTP 400
// `{ error, error_description }` (the same shape Better-Auth's own endpoint returns),
// so a generic device-flow poller works against Motir unchanged and `motir login`'s
// branch is the standard one. `server_error` is the single 500. Deliberately NOT the
// `{ code }` convention the session routes use — this route's consumer is an OAuth
// client, not the Motir web app.
//
// Two of the five are the NORMAL path: `authorization_pending` is what the CLI sees
// for the entire time the human is walking to their browser, and `slow_down` is the
// per-grant throttle. Neither is shown to the user as an error.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.

/** RFC 8628 §3.4 — the only grant type this endpoint honours. */
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;

function oauthError(error: string, description: string, status: number): Response {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: NO_STORE },
  );
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthError('invalid_request', 'Expected a JSON body.', 400);
  }
  const { grant_type, device_code, client_id } = (body ?? {}) as {
    grant_type?: unknown;
    device_code?: unknown;
    client_id?: unknown;
  };

  // A malformed request answers `invalid_request` rather than a bespoke code, so the
  // CLI's branch stays the five states the ADR pins plus `server_error` — there is no
  // sixth case for it to fall through on.
  if (grant_type !== DEVICE_CODE_GRANT_TYPE) {
    return oauthError('invalid_request', `grant_type must be ${DEVICE_CODE_GRANT_TYPE}.`, 400);
  }
  if (typeof device_code !== 'string' || device_code.length === 0) {
    return oauthError('invalid_request', 'A device_code is required.', 400);
  }
  if (typeof client_id !== 'string' || client_id.length === 0) {
    return oauthError('invalid_request', 'A client_id is required.', 400);
  }

  try {
    const granted = await cliDeviceService.poll({ deviceCode: device_code, clientId: client_id });
    return NextResponse.json(granted, { headers: NO_STORE });
  } catch (err) {
    // The whole RFC family in one branch — `authorization_pending`, `slow_down`,
    // `access_denied`, `expired_token`, `invalid_grant` — mapped off the error's own
    // `oauthError`, so a new state added to the domain cannot be forgotten here.
    if (err instanceof DeviceGrantError) {
      return oauthError(err.oauthError, err.message, 400);
    }
    // "Not your fault, try again" — the only 500 the CLI treats as retryable.
    if (err instanceof DeviceGrantUnboundError) {
      return oauthError('server_error', 'The device grant could not be completed.', 500);
    }
    throw err;
  }
}
