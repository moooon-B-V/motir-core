import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { apiTokensService } from '@/lib/services/apiTokensService';
import {
  ApiTokenExpiredError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
} from '@/lib/apiTokens/errors';
import { TOKEN_PREFIX } from '@/lib/apiTokens/token';
import type { McpAuthExtra } from './context';

// The MCP server's transport-level auth gate (Story 7.8 · Subtask 7.8.4).
//
// This is the ONLY authorization logic in the MCP layer — no tool re-checks
// permissions. mcp-handler's `withMcpAuth(handler, verifyMcpToken, { required:
// true })` calls this for every request and, when it returns `undefined`,
// rejects the request with a 401 (`WWW-Authenticate`) BEFORE any JSON-RPC tool
// dispatch — the MCP-spec-correct, transport-level place to reject auth (the
// spec's auth is transport-level; an OAuth layer could be added in front later
// without re-shaping a single tool — story-7.8 header, the PAT-over-OAuth
// deviation). On success it resolves the actor and stashes `{ userId,
// workspaceId }` in `AuthInfo.extra`; from there every tool builds the same
// `ServiceContext` the cookie session would have produced, so the tools hit the
// exact 6.4 role checks + the 404-not-403 cross-tenant contract the routes do.
//
// The workspace comes from the TOKEN, not the user's default (bug 7.21). A PAT
// is workspace-scoped (the verified Linear mirror): `verify` returns the
// `workspaceId` the token was bound to at mint time, and that IS the request
// workspace — so a token minted in workspace A always acts on A, even when A is
// not the owner's oldest/default workspace. (The retired behaviour resolved the
// owner's first workspace via `resolveActiveWorkspace(userId, null)`, which made
// every token act on the signup-default workspace and left projects in any other
// workspace unreachable.) The per-tool 6.4 gates still apply with this
// `workspaceId`, so a token whose owner has lost membership simply gets the same
// 404-not-403 the cookie path would.

/** Extract the `Bearer` credential from an Authorization header value. */
function bearerFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Resolve a bearer PAT to the {@link AuthInfo} mcp-handler attaches to the
 * request (`req.auth`), or `undefined` to reject the request as unauthenticated
 * (→ 401 before any tool runs).
 *
 * `bearerToken` is supplied by mcp-handler (parsed from the `Authorization`
 * header); we fall back to parsing the header off `req` so the function is also
 * usable/testable standalone. Unknown / revoked / expired / malformed tokens
 * all resolve to `undefined` — a uniform rejection that never distinguishes the
 * reason to a caller. Any OTHER error (a real outage) propagates, so it surfaces
 * as a 500 rather than masquerading as an auth failure.
 */
export async function verifyMcpToken(
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  const token = bearerToken ?? bearerFromHeader(req.headers.get('authorization'));
  if (!token || !token.startsWith(TOKEN_PREFIX)) return undefined;

  let user;
  let workspaceId: string;
  try {
    ({ user, workspaceId } = await apiTokensService.verify(token));
  } catch (err) {
    if (
      err instanceof InvalidApiTokenError ||
      err instanceof ApiTokenRevokedError ||
      err instanceof ApiTokenExpiredError
    ) {
      return undefined;
    }
    throw err;
  }

  // The request workspace IS the workspace the token was bound to at mint time
  // (bug 7.21) — NOT the owner's default workspace. The per-tool 6.4 gates
  // enforce access with it.
  const extra: McpAuthExtra = { userId: user.id, workspaceId, userName: user.name };
  return {
    token,
    clientId: user.id,
    scopes: [],
    extra: { ...extra },
  };
}
