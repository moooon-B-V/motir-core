import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workspacesService } from '@/lib/services/workspacesService';
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
// Why resolve the workspace HERE (once per request) rather than per tool: it's
// a DB read, and the actor is the same for every tool in the request. A PAT has
// no cookie, so there is no "active workspace" hint — we resolve the user's
// active/default workspace the same way the cookie-less path does
// (`resolveActiveWorkspace(userId, null)`), which returns the user's first
// workspace (self-healing a zero-membership user exactly like the HTTP path).
// A future tool that needs to act across multiple of the user's workspaces
// would take an explicit workspace selector; today the contract matches the
// single-active-workspace shape the rest of the app uses.

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
  try {
    user = await apiTokensService.verify(token);
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

  // No cookie hint → resolve the actor's active/default workspace (the same
  // cookie-less resolution the HTTP middleware uses). Null only if the user has
  // no workspace AND the self-heal could not create one — reject in that case.
  const workspaceId = await workspacesService.resolveActiveWorkspace(user.id, null, user.name);
  if (!workspaceId) return undefined;

  const extra: McpAuthExtra = { userId: user.id, workspaceId, userName: user.name };
  return {
    token,
    clientId: user.id,
    scopes: [],
    extra: { ...extra },
  };
}
