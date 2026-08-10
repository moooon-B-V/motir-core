import type { PermissionKey } from '@/lib/permissions/catalog';
import { grantAllows } from '@/lib/tokens/grant';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { TOKEN_PREFIX } from '@/lib/apiTokens/token';
import {
  ApiTokenExpiredError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
} from '@/lib/apiTokens/errors';

/**
 * Bearer-token auth for a plain REST route (Story MOTIR-1627 · Subtask
 * MOTIR-1631) — the non-MCP counterpart to `verifyMcpToken`. The acceptance-video
 * publish endpoint is the first REST route a CI/service token (not a session
 * cookie) may call, so it authenticates the `Authorization: Bearer motir_pat_…`
 * header the same way: resolve the token to its bound `{ userId, workspaceId }`
 * and require a specific PERMISSION (MOTIR-2576 — it took a `TokenScope` until
 * the vocabularies merged).
 *
 * Returns a discriminated result the route maps to a status: `unauthenticated`
 * → 401 (missing / malformed / unknown / revoked / expired — never
 * distinguished, matching the MCP gate), `forbidden` → 403 (valid token, but its
 * grant does not hold the required permission). A real outage propagates so it
 * surfaces as a 500, not a masked auth failure.
 */
export type ApiTokenAuthResult =
  | { ok: true; userId: string; workspaceId: string }
  | { ok: false; reason: 'unauthenticated' | 'forbidden' };

function bearerFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

export async function authenticateApiToken(
  req: Request,
  requiredPermission: PermissionKey,
): Promise<ApiTokenAuthResult> {
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token || !token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: 'unauthenticated' };

  let user;
  let workspaceId: string;
  let grant: PermissionKey[];
  try {
    ({ user, workspaceId, grant } = await apiTokensService.verify(token));
  } catch (err) {
    if (
      err instanceof InvalidApiTokenError ||
      err instanceof ApiTokenRevokedError ||
      err instanceof ApiTokenExpiredError
    ) {
      return { ok: false, reason: 'unauthenticated' };
    }
    throw err;
  }

  if (!grantAllows(grant, requiredPermission)) return { ok: false, reason: 'forbidden' };
  return { ok: true, userId: user.id, workspaceId };
}
