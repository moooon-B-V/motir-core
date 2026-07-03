import { createSign } from 'node:crypto';
import type { InstallationToken } from '@/lib/git/types';

// GitHub App authentication leaf primitive (Story 7.10 · MOTIR-891). Mints the
// short-lived INSTALLATION access token a service needs to call GitHub on an
// installation's behalf. Two-step, per GitHub's App-auth model:
//   1. sign a JWT (RS256) with the App private key — proves "I am the App"
//      (iss = App id, exp ≤ 10 min);
//   2. POST it to the installation's access-token endpoint → a token scoped by
//      GitHub to that installation's selected repos, valid ~1h.
//
// The token is NEVER persisted (the card's hard requirement): it is cached
// in-memory per installation until just before its reported expiry, then
// re-minted. This is the `lib/email.ts`-style leaf primitive — SERVICES import
// it (through the GitProvider seam); routes never do. Config is read at CALL
// time (never module load), so a self-hosted deploy that never wires the GitHub
// App does not crash on boot — the flow simply isn't reachable.

const APP_ID_ENV = 'GITHUB_APP_ID';
const PRIVATE_KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';
const GITHUB_API = 'https://api.github.com';

// Re-mint this many ms BEFORE the reported expiry so an in-flight call never
// races the boundary (GitHub installation tokens last ~1h; a 60s skew is ample).
const EXPIRY_SKEW_MS = 60_000;

/** The GitHub App credentials (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`) are
 *  not configured on this deployment. Read at call time so an instance that
 *  never wires the App can't reach the flow rather than crashing on boot. */
export class GithubAppNotConfiguredError extends Error {
  readonly code = 'GITHUB_APP_NOT_CONFIGURED' as const;
  constructor() {
    super(`GitHub App is not configured. Set ${APP_ID_ENV} and ${PRIVATE_KEY_ENV}.`);
    this.name = 'GithubAppNotConfiguredError';
  }
}

/** Minting the installation token failed (JWT signing, the token endpoint, or an
 *  unexpected response). Never carries GitHub's raw body. */
export class GithubAppTokenError extends Error {
  readonly code = 'GITHUB_APP_TOKEN_FAILED' as const;
  constructor(detail: string) {
    super(`GitHub installation-token mint failed: ${detail}`);
    this.name = 'GithubAppTokenError';
  }
}

interface AppConfig {
  appId: string;
  privateKeyPem: string;
}

function resolveConfig(): AppConfig {
  const appId = process.env[APP_ID_ENV];
  const rawKey = process.env[PRIVATE_KEY_ENV];
  if (!appId || !rawKey) throw new GithubAppNotConfiguredError();
  // Env commonly stores the PEM with escaped newlines (`\n`); restore real
  // newlines so the crypto layer can parse it. A key already carrying literal
  // newlines is left unchanged.
  const privateKeyPem = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  return { appId, privateKeyPem };
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/**
 * Build a signed App JWT (RS256). `nowSeconds` is injectable for tests and
 * defaults to the wall clock. `iat` is backdated 60s to tolerate clock skew
 * between us and GitHub (GitHub's documented guidance); `exp` stays under the
 * 10-minute ceiling. Throws {@link GithubAppNotConfiguredError} when unwired or
 * {@link GithubAppTokenError} when the key can't sign.
 */
export function createAppJwt(nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const { appId, privateKeyPem } = resolveConfig();
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60, // ≤ 10 min; 9 stays clear of the ceiling
    iss: appId,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem, 'base64url');
  } catch (err) {
    throw new GithubAppTokenError(
      `could not sign the App JWT (${err instanceof Error ? err.message : 'unknown'})`,
    );
  }
  return `${signingInput}.${signature}`;
}

// In-memory installation-token cache — process-local, NEVER persisted. Keyed by
// the provider installation id.
const cache = new Map<string, InstallationToken>();

/**
 * Mint (or return a still-valid cached) installation access token for
 * `installationId`. Minted from the App JWT, scoped by GitHub to the
 * installation's repos, cached until `EXPIRY_SKEW_MS` before its reported expiry,
 * then re-minted. NEVER persisted. Throws {@link GithubAppNotConfiguredError}
 * (unwired) or {@link GithubAppTokenError} (endpoint / shape failure).
 */
export async function mintInstallationToken(installationId: string): Promise<InstallationToken> {
  const cached = cache.get(installationId);
  if (cached && cached.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) {
    return cached;
  }

  const jwt = createAppJwt();
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
      },
    });
  } catch (err) {
    throw new GithubAppTokenError(
      `token endpoint unreachable (${err instanceof Error ? err.message : 'unknown'})`,
    );
  }
  if (!res.ok) throw new GithubAppTokenError(`token endpoint returned ${res.status}`);

  let body: { token?: string; expires_at?: string };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new GithubAppTokenError('token endpoint returned a non-JSON body');
  }
  if (!body.token || !body.expires_at) {
    throw new GithubAppTokenError('token endpoint returned an unexpected shape');
  }

  const token: InstallationToken = { token: body.token, expiresAt: new Date(body.expires_at) };
  cache.set(installationId, token);
  return token;
}

/** Test-only: clear the in-memory installation-token cache between tests. */
export function _resetInstallationTokenCache(): void {
  cache.clear();
}
