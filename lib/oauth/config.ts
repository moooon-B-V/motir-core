import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// Motir as an OAuth 2.1 authorization server for exactly ONE protected resource,
// its MCP (Story MOTIR-6973 · Subtask MOTIR-6982). Every URL here is DERIVED from
// `lib/baseUrl.ts` — the one module that owns the app's origin — so production,
// a preview and `localhost` all answer about themselves without a new variable.

/** Where the MCP is served, relative to the origin. */
export const MCP_RESOURCE_PATH = '/api/mcp';

/** Better-Auth's mount point — the provider's endpoints live beneath it. */
export const AUTH_BASE_PATH = '/api/auth';

/** The RFC 9728 protected-resource metadata document — where an MCP client is
 * pointed by the 401's `WWW-Authenticate: … resource_metadata` (MOTIR-6983). */
export const PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** Where the provider sends a signed-in person to decide (MOTIR-6985 draws it). */
export const OAUTH_CONSENT_PAGE = '/oauth/consent';

/**
 * Where a REFUSED authorize request is shown (MOTIR-6985, design Panel 7): an
 * unknown client or an unregistered redirect, whose only address on hand may be
 * an attacker's, so the refusal is Motir's own page and never a redirect to it.
 */
export const OAUTH_ERROR_PAGE = '/oauth/error';

/** The refused-request page for one error code, with the host an unregistered
 * redirect asked for (display only — it is shown as data, never followed). */
export function oauthErrorPageUrl(error: string, host?: string | null): string {
  const url = new URL(OAUTH_ERROR_PAGE, `${resolveBaseUrlTrimmed()}/`);
  url.searchParams.set('error', error);
  if (host) url.searchParams.set('host', host);
  return url.toString();
}

/** Where the provider sends a signed-out person first. */
export const OAUTH_LOGIN_PAGE = '/sign-in';

/**
 * The scopes a client may ask for. `offline_access` is the one that matters: the
 * provider issues a refresh token only when it is granted, and a connector that
 * cannot refresh has to send its person back through consent every hour. What a
 * grant may DO is not a scope — it is the consent decision's workspace and
 * permission keys (MOTIR-6983) — so there is nothing else to list.
 */
export const OAUTH_SCOPES = ['offline_access'] as const;

/** The MCP's canonical URI — the ONLY `resource` (RFC 8707) a token may name. */
export function mcpResourceUrl(): string {
  return `${resolveBaseUrlTrimmed()}${MCP_RESOURCE_PATH}`;
}

/**
 * The authorization server's issuer identifier. It is Better-Auth's own base URL
 * — the origin plus `/api/auth` — because that is the value the provider stamps
 * on every authorization response as `iss` (RFC 9207). Advertising the bare
 * origin instead would hand a client an issuer that disagrees with the `iss` it
 * then receives, which a conforming client must refuse. So the protected-resource
 * document names THIS, and RFC 8414's path-inserted metadata URL
 * (`/.well-known/oauth-authorization-server/api/auth`) serves it.
 */
export function authorizationServerIssuer(): string {
  return `${resolveBaseUrlTrimmed()}${AUTH_BASE_PATH}`;
}
