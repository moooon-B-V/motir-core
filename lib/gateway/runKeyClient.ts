import 'server-only';

import {
  GatewayRunKeyConfigError,
  GatewayRunKeyRefusedError,
  GatewayRunKeyUnavailableError,
} from './errors';

// THE MOTIR-CORE → MOTIR-GATEWAY RUN-KEY CLIENT (MOTIR-689) — a SERVER-ONLY leaf
// primitive, like `lib/ai/motirAiClient.ts`. It mints and revokes the per-run
// model key a hosted agent run holds (`docs/decisions/hosted-agent-run.md` §1,
// §6, §7), over HTTP and nothing else: motir-core never imports the gateway.
//
// The contract is the gateway's (`controller/motir_run_key.go`, and
// `docs/hosted-run-egress.md` §1 there):
//
//   POST   /api/motir/run-keys          {runRef, coreOrganizationId, expiresAt, models?}
//                                       → 201 {key, runRef, coreOrganizationId, expiresAt, lane}
//   DELETE /api/motir/run-keys/:runRef  → 200 {runRef, revoked}
//
// both authorised by `Authorization: Bearer <MOTIR_RUN_KEY_MINT_SECRET>`, and
// refusing with `{ error: { code, message } }`. `expiresAt` is UNIX SECONDS.
//
// ⚠️ `MOTIR_RUN_KEY_MINT_SECRET` IS READ HERE AND NOWHERE ELSE, AT CALL TIME. The
// `server-only` import makes bundling this module into a Client Component a
// build error, so the secret cannot reach a browser; reading at call time lets
// the module import cleanly in a deployment that never runs hosted.

export const MOTIR_GATEWAY_URL_ENV_VAR = 'MOTIR_GATEWAY_URL';
export const MOTIR_RUN_KEY_MINT_SECRET_ENV_VAR = 'MOTIR_RUN_KEY_MINT_SECRET';

/** The deadline on one mint or revoke — both are single-row writes at the far end. */
export const GATEWAY_RUN_KEY_TIMEOUT_MS = 15_000;

/**
 * The gateway's ORIGIN, as `MOTIR_GATEWAY_URL` names it — trailing slashes
 * removed. It is also the value the container receives verbatim (the egress
 * contract appends `/v1` itself), so a value that already ends in `/v1` is a
 * misconfiguration that would send OpenCode to `/v1/v1/messages`: refused here,
 * loudly, rather than discovered as a run whose every model call 404s.
 */
export function gatewayBaseUrl(): string {
  const raw = process.env[MOTIR_GATEWAY_URL_ENV_VAR]?.trim();
  if (!raw) throw new GatewayRunKeyConfigError(`${MOTIR_GATEWAY_URL_ENV_VAR} is not set`);
  const url = raw.replace(/\/+$/, '');
  if (/\/v1$/.test(url)) {
    throw new GatewayRunKeyConfigError(
      `${MOTIR_GATEWAY_URL_ENV_VAR} must be the gateway's origin, without a trailing /v1`,
    );
  }
  return url;
}

function mintSecret(): string {
  const secret = process.env[MOTIR_RUN_KEY_MINT_SECRET_ENV_VAR]?.trim();
  if (!secret) {
    throw new GatewayRunKeyConfigError(`${MOTIR_RUN_KEY_MINT_SECRET_ENV_VAR} is not set`);
  }
  return secret;
}

async function gatewayFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_RUN_KEY_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new GatewayRunKeyUnavailableError(
        `the gateway did not respond within ${GATEWAY_RUN_KEY_TIMEOUT_MS}ms`,
      );
    }
    throw new GatewayRunKeyUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Map a non-2xx answer to its typed error. A 5xx is UNAVAILABLE, except the
 *  gateway's own `503 run_keys_not_configured`, which is a definite refusal. */
async function refusal(res: Response): Promise<Error> {
  let code = 'unknown';
  let message = res.statusText || `the gateway answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    if (typeof body?.error?.code === 'string') code = body.error.code;
    if (typeof body?.error?.message === 'string') message = body.error.message;
  } catch {
    // not JSON — keep the status line
  }
  if (res.status >= 500 && code !== 'run_keys_not_configured') {
    return new GatewayRunKeyUnavailableError(`${res.status} ${code}: ${message}`);
  }
  return new GatewayRunKeyRefusedError(res.status, code, message);
}

export interface MintGatewayRunKeyInput {
  /** The run's `DispatchRun.id` (§1). */
  runRef: string;
  /** The organization that pays. */
  coreOrganizationId: string;
  expiresAt: Date;
  /** The key's model allow-list — BARE gateway ids, sent exactly as given. */
  models: string[];
}

export interface MintedGatewayRunKey {
  /** The `sk-…` key, returned ONCE by the gateway. */
  key: string;
  runRef: string;
  coreOrganizationId: string;
  expiresAt: Date;
  lane: string;
}

/** POST /api/motir/run-keys. Throws a typed {@link GatewayRunKeyConfigError},
 *  {@link GatewayRunKeyRefusedError} or {@link GatewayRunKeyUnavailableError}. */
export async function mintGatewayRunKey(
  input: MintGatewayRunKeyInput,
): Promise<MintedGatewayRunKey> {
  const url = gatewayBaseUrl();
  const secret = mintSecret();
  const res = await gatewayFetch(`${url}/api/motir/run-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      runRef: input.runRef,
      coreOrganizationId: input.coreOrganizationId,
      expiresAt: Math.floor(input.expiresAt.getTime() / 1000),
      models: input.models,
    }),
  });
  if (!res.ok) throw await refusal(res);
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown> | null;
  } catch {
    // handled below
  }
  if (!body || typeof body['key'] !== 'string' || body['key'].length === 0) {
    throw new GatewayRunKeyUnavailableError('the gateway minted no key');
  }
  return {
    key: body['key'],
    runRef: typeof body['runRef'] === 'string' ? body['runRef'] : input.runRef,
    coreOrganizationId:
      typeof body['coreOrganizationId'] === 'string'
        ? body['coreOrganizationId']
        : input.coreOrganizationId,
    expiresAt:
      typeof body['expiresAt'] === 'number' ? new Date(body['expiresAt'] * 1000) : input.expiresAt,
    lane: typeof body['lane'] === 'string' ? body['lane'] : 'agent',
  };
}

export interface RevokedGatewayRunKeys {
  runRef: string;
  /** How many keys the gateway disabled. `0` is a normal answer: teardown may run twice. */
  revoked: number;
}

/** DELETE /api/motir/run-keys/:runRef. Throws the same three typed errors. */
export async function revokeGatewayRunKeys(runRef: string): Promise<RevokedGatewayRunKeys> {
  const url = gatewayBaseUrl();
  const secret = mintSecret();
  const res = await gatewayFetch(`${url}/api/motir/run-keys/${encodeURIComponent(runRef)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw await refusal(res);
  let revoked = 0;
  try {
    const body = (await res.json()) as { revoked?: unknown } | null;
    if (typeof body?.revoked === 'number') revoked = body.revoked;
  } catch {
    // a 200 with no body still revoked
  }
  return { runRef, revoked };
}
