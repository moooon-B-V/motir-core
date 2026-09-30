// The redirect policy for dynamically registered OAuth clients (MOTIR-6982).
//
// A registered `redirect_uri` must be `https`, or `http` on a LOOPBACK host
// (RFC 8252 §7.3). That admits `https://claude.ai/api/mcp/auth_callback` and a
// native client's `http://127.0.0.1:<port>/callback`, and refuses everything else
// — a plain-`http` public host (a code sent in the clear) and a custom scheme
// (`myapp://`, which any installed app can claim). The provider's own schema
// accepts custom schemes, so this is enforced in front of it
// (`lib/auth/mcpOAuthPolicy.ts`).

/** The loopback host names a native client may register. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

/** Whether one `redirect_uri` may be registered. A fragment is never allowed. */
export function isAllowedRedirectUri(uri: string): boolean {
  const url = parse(uri);
  if (!url || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

/**
 * Whether a `redirect_uri` on an authorize request matches one the client
 * registered: exactly, or — for a loopback registration only — ignoring the PORT,
 * which a native client learns from the operating system at run time (RFC 8252
 * §7.3). Scheme, host, path and query must still match exactly.
 */
export function matchesRegisteredRedirect(
  registered: readonly string[],
  requested: string,
): boolean {
  const want = parse(requested);
  if (!want) return false;
  return registered.some((candidate) => {
    if (candidate === requested) return true;
    const have = parse(candidate);
    return (
      !!have &&
      isLoopbackHostname(have.hostname) &&
      have.protocol === want.protocol &&
      have.hostname === want.hostname &&
      have.pathname === want.pathname &&
      have.search === want.search
    );
  });
}
