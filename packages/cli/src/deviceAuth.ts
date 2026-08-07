import { CliError } from './errors.js';

// THE DEVICE-AUTHORIZATION TRANSPORT — the one place `packages/cli` reaches a
// route outside `/api/v1`, and why that is not a drift.
//
// Every other command goes through `client.ts`, whose every request carries an
// `Authorization: Bearer <pat>`. `motir login` structurally cannot use it — it
// runs BEFORE a credential exists, so there is no bearer to present. It
// therefore speaks plain JSON/HTTP to Motir's own `/api/cli/device/*` routes.
//
// NOT Better-Auth's `/api/auth/device/*`, which is the obvious guess and the wrong
// one: that endpoint completes into a browser SESSION, and no bearer gate in this
// repo accepts a session token. Motir owns the CLI-facing routes for exactly that
// reason (`lib/services/cliDeviceService.ts`, `docs/decisions/cli-login.md`), and
// the plugin stays a private implementation detail behind them.
//
// The exception is bounded by construction: two endpoints, both unauthenticated by
// design, both reached only from `commands/login.ts`, and the moment the poll
// succeeds the CLI holds a PAT and everything after it is `/api/v1`.

/**
 * The `client_id` this CLI presents. Pinned server-side too
 * (`lib/cliDevice/constants.ts` — `CLI_CLIENT_ID`); the literal is duplicated
 * rather than imported because `packages/cli` is a separate package with its own
 * build and cannot reach into the app root. Changing it is a contract change on
 * both sides at once — old binaries get `invalid_grant`.
 */
export const CLI_CLIENT_ID = 'motir-cli';

/** RFC 8628 §3.4 — the only grant type the poll endpoint honours. */
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export const DEVICE_START_PATH = '/api/cli/device/start';
export const DEVICE_TOKEN_PATH = '/api/cli/device/token';

/** The grant, as `POST /api/cli/device/start` hands it back (RFC 8628 §3.2). */
export interface DeviceGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  /** Seconds until the codes expire — the CLI's own polling budget. */
  expires_in: number;
  /** Minimum seconds between polls; faster answers `slow_down`. */
  interval: number;
}

/**
 * The successful poll. `user` / `workspace` are Motir's additions to the RFC
 * shape, added by the substrate SO THAT `motir login` can print its confirmation
 * without a second round trip — see `lib/dto/cliDevice.ts`, which says so. The
 * device path also skips the `whoami` validation the paste path performs: a
 * server-minted token cannot be the wrong token.
 */
export interface DeviceCredential {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; slug: string };
}

/**
 * What one poll answered. The three NON-terminal states are values; the three
 * terminal failures are thrown, because there is nothing for the caller to decide
 * about them.
 *
 * `pending` and `slow_down` are the NORMAL path — the CLI sits in them for the
 * whole time the human is walking to a browser — which is why neither is an error
 * here even though RFC 8628 transports them as one.
 */
export type PollResult =
  | { state: 'granted'; credential: DeviceCredential }
  | { state: 'pending' }
  | { state: 'slow_down' }
  /** HTTP 500 `server_error` — "not your fault, try again." Keep polling. */
  | { state: 'retry' };

/** A JSON body, or `undefined` when the response carried something else. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    // A non-JSON body means we are not talking to a Motir device endpoint at all
    // (an HTML 404 from a wrong host, a proxy error page). The callers turn that
    // into "this server does not look like Motir" rather than a parse crash.
    return undefined;
  }
}

/**
 * POST a JSON body, turning a transport failure into a `CliError` naming the
 * server. A `fetch` rejection here is DNS / TLS / connection-refused — the user
 * mistyped `--server` or the host is down — and the raw `TypeError: fetch failed`
 * says none of that.
 */
async function postJson(url: string, body: unknown, serverUrl: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError(`Could not reach ${serverUrl}.`, {
      hint: 'Check the URL (--server <url> or MOTIR_SERVER) and that the server is running.',
    });
  }
}

/** The RFC 8628 `error` value out of an error body, if it carried one. */
function oauthErrorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' ? error : undefined;
}

/**
 * Open a grant (`POST /api/cli/device/start`). Unauthenticated by design — a
 * device grant is opened before anyone is identified.
 *
 * `hostname` is reported so the approval screen can answer "WHAT is connecting",
 * which the ADR leans on as the device grant's phishing mitigation, and so the
 * minted token is labelled `CLI · <hostname>` in Settings → Account → API tokens.
 * It is display-only on the server and never interpreted.
 */
export async function startDeviceGrant(input: {
  serverUrl: string;
  hostname: string;
}): Promise<DeviceGrant> {
  const res = await postJson(
    input.serverUrl + DEVICE_START_PATH,
    { hostname: input.hostname },
    input.serverUrl,
  );
  const body = await readJson(res);

  if (!res.ok) {
    throw new CliError(`${input.serverUrl} refused to start a login (HTTP ${res.status}).`, {
      hint: 'If this is a self-hosted Motir, it may predate `motir login` — use `motir auth login --token <pat>` instead.',
    });
  }

  const grant = body as Partial<DeviceGrant> | undefined;
  // A 200 that is not a grant means the URL resolves to something that is not a
  // Motir device endpoint. Naming that is worth more than an undefined-property
  // crash three lines later.
  if (typeof grant?.device_code !== 'string' || typeof grant.user_code !== 'string') {
    throw new CliError(`${input.serverUrl} did not return a device grant.`, {
      hint: 'Check that --server points at a Motir server (it should serve /api/cli/device/start).',
    });
  }
  return grant as DeviceGrant;
}

/**
 * Poll once (`POST /api/cli/device/token`). The five RFC 8628 states plus
 * `server_error`, mapped onto {@link PollResult} — the three the caller can act on
 * are returned, the three that end the login are thrown as `CliError`s carrying
 * the way forward.
 *
 * Every terminal failure here happens BEFORE anything is written to disk (the
 * caller stores only on `granted`), which is what makes "a denied, expired or
 * interrupted login writes no credential" structural rather than a promise.
 */
export async function pollDeviceGrant(input: {
  serverUrl: string;
  deviceCode: string;
}): Promise<PollResult> {
  const res = await postJson(
    input.serverUrl + DEVICE_TOKEN_PATH,
    {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: input.deviceCode,
      client_id: CLI_CLIENT_ID,
    },
    input.serverUrl,
  );
  const body = await readJson(res);

  if (res.ok) {
    const credential = body as Partial<DeviceCredential> | undefined;
    if (typeof credential?.access_token !== 'string') {
      throw new CliError(`${input.serverUrl} approved the login but returned no token.`);
    }
    return { state: 'granted', credential: credential as DeviceCredential };
  }

  switch (oauthErrorCode(body)) {
    case 'authorization_pending':
      return { state: 'pending' };
    case 'slow_down':
      return { state: 'slow_down' };
    case 'server_error':
      return { state: 'retry' };
    case 'access_denied':
      throw new CliError('Approval was denied. No credential was written.', {
        hint: 'Run `motir login` again if that was not you — and revoke nothing: nothing was created.',
      });
    case 'expired_token':
      throw new CliError('The code expired before it was approved.', {
        hint: 'Codes last 15 minutes. Run `motir login` again for a fresh one.',
      });
    default:
      // `invalid_grant` (unknown / already-consumed device code, client mismatch),
      // `invalid_request`, or an unrecognised body. All are bugs or tampering, not
      // something a retry fixes.
      throw new CliError(`The login could not be completed (HTTP ${res.status}).`, {
        hint: 'Run `motir login` again to start a fresh grant.',
      });
  }
}
