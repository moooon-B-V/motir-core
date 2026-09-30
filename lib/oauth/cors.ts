// Cross-origin answers for the OAuth discovery documents (MOTIR-6982).
//
// `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
// are PUBLIC metadata: a browser-based MCP client reads them from its own origin,
// so they answer every origin. `*` and never credentials — nothing here depends on
// who is asking, and a cookie would change nothing (`proxy.ts` applies these).

export const WELL_KNOWN_PREFIX = '/.well-known/';

export const WELL_KNOWN_CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};
