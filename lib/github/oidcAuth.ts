import { createRemoteJWKSet, jwtVerify } from 'jose';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';

// Keyless BYOK publish auth (MOTIR-1650, per the acceptance-video ADR §4
// amendment). A repo connected via the MOTIR-810 GitHub App can publish its
// acceptance video straight from GitHub Actions with NO Motir token: the Actions
// run presents its OIDC identity, we verify the JWT against GitHub's JWKS,
// resolve the `repository` claim → the tenant's workspace, and attribute the
// upload to the workspace owner. The `integration` PAT stays the fallback for a
// repo NOT connected via the App (`authenticateGithubOidc` returns `null` then,
// and the route runs the PAT path).

const DEFAULT_ISSUER = 'https://token.actions.githubusercontent.com';

/** The value a caller puts on the `X-Motir-Auth` header to opt INTO the keyless
 *  path. Absent → the route uses the PAT path, so the existing contract is
 *  unchanged. */
export const GITHUB_OIDC_AUTH_MARKER = 'github-oidc';

// Read config at call time (not module load) so a test can set the env before
// the first verify. Issuer/JWKS/audience are overridable for tests that mint +
// serve their own keys.
function oidcConfig(): { issuer: string; jwksUrl: string; audience: string } {
  const issuer = process.env.GITHUB_OIDC_ISSUER ?? DEFAULT_ISSUER;
  return {
    issuer,
    jwksUrl: process.env.GITHUB_OIDC_JWKS_URL ?? `${issuer}/.well-known/jwks`,
    audience: process.env.GITHUB_OIDC_AUDIENCE ?? 'motir-acceptance-video',
  };
}

// One cached JWKS resolver per URL — jose caches the keys and refreshes on
// rotation, so this must survive across requests (a module-level cache).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(url: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, set);
  }
  return set;
}

export type OidcAuthResult =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Authenticate a keyless GitHub-OIDC acceptance-video publish.
 *
 * Returns `null` when the caller did NOT opt into OIDC (no `X-Motir-Auth:
 * github-oidc` marker) — the route then falls back to the `integration` PAT
 * path, so nothing about the existing contract changes. Otherwise returns a
 * typed result the route maps to HTTP:
 *   - `{ ok:true, userId, workspaceId }` — verified; `userId` is the workspace
 *     OWNER (OIDC carries no user, and `Attachment.uploaderUserId` is required).
 *   - `{ ok:false, status:401 }` — the OIDC JWT is missing / unverifiable /
 *     wrong-audience / expired / lacks a usable `repository` claim.
 *   - `{ ok:false, status:403 }` — the JWT is valid but its repo is not
 *     connected via the App (or is ambiguous), or the workspace has no owner.
 *
 * SECURITY: the `repository` claim (and thus the tenant) is trusted ONLY after
 * `jwtVerify` checks the signature against GitHub's JWKS + the issuer + the
 * audience + expiry. No claim is read before verification.
 */
export async function authenticateGithubOidc(req: Request): Promise<OidcAuthResult | null> {
  if (req.headers.get('x-motir-auth') !== GITHUB_OIDC_AUTH_MARKER) return null;

  const authz = req.headers.get('authorization');
  const token = authz && authz.startsWith('Bearer ') ? authz.slice('Bearer '.length).trim() : '';
  if (!token) return { ok: false, status: 401, reason: 'missing_oidc_token' };

  const { issuer, jwksUrl, audience } = oidcConfig();
  let repository: unknown;
  try {
    const { payload } = await jwtVerify(token, jwksFor(jwksUrl), { issuer, audience });
    repository = payload.repository;
  } catch {
    return { ok: false, status: 401, reason: 'invalid_oidc_token' };
  }

  // `repository` is GitHub's `owner/name` coordinate.
  if (typeof repository !== 'string') {
    return { ok: false, status: 401, reason: 'missing_repository_claim' };
  }
  const slash = repository.indexOf('/');
  if (slash <= 0 || slash === repository.length - 1) {
    return { ok: false, status: 401, reason: 'missing_repository_claim' };
  }
  const owner = repository.slice(0, slash);
  const name = repository.slice(slash + 1);

  // The verified `repository` claim determines the tenant → resolve it GLOBALLY
  // (the caller has no workspace yet). Reject unconnected OR ambiguous — never
  // silently pick a workspace when a coordinate resolves to more than one.
  const matches = await githubRepoRepository.findConnectedByName(owner, name);
  const [match, ...rest] = matches;
  if (!match || rest.length > 0) {
    return { ok: false, status: 403, reason: 'repo_not_connected' };
  }
  const workspaceId = match.installation.workspaceId;

  // Actor = the workspace owner (the ADR §4 keyless-actor decision): OIDC has no
  // user, but `Attachment.uploaderUserId` is required. A `db` read, no context
  // (mirrors the 6.12 public-submit owner-as-reporter seam).
  const ownerMembership = await workspaceMembershipRepository.findOwnerByWorkspace(workspaceId);
  if (!ownerMembership) {
    return { ok: false, status: 403, reason: 'workspace_owner_missing' };
  }

  return { ok: true, userId: ownerMembership.userId, workspaceId };
}
