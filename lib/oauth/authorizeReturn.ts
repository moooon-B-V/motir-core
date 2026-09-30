import { AUTH_BASE_PATH, mcpResourceUrl } from './config';

// Returning a signed-out person to the authorize request they started
// (MOTIR-6982).
//
// The provider sends a signed-out person to `/sign-in?<the request, signed>`.
// Motir's sign-in card does not speak the provider's `oauth_query` resume
// protocol; it already speaks `next=` (`lib/navigation/nextDestination.ts`). So
// the sign-in page turns the provider's redirect into a `next` that points back
// at the AUTHORIZE endpoint with the original request — which, re-run with a
// session, validates it afresh and continues to consent. Nothing is trusted from
// the signed copy: the authorize endpoint checks the request again.

/** The provider's signing parameters — meaningful only to its own redirect. */
const SIGNING_PARAMS = ['sig', 'exp', 'ba_iat', 'ba_pl'];

/** Whether these sign-in params are an OAuth authorize request in flight. */
export function isOAuthAuthorizeHandoff(params: URLSearchParams): boolean {
  return params.has('client_id') && params.has('response_type') && params.has('sig');
}

/**
 * The `next` destination for a sign-in page reached from the authorize endpoint,
 * or null when the params are not such a handoff. `prompt=login` / `create` are
 * dropped: they asked for a sign-in, and the person is about to have done one —
 * carrying them back would send the authorize endpoint straight here again.
 *
 * ⚠️ `resource` IS PUT BACK. The provider signs only the parameters it knows,
 * and RFC 8707's `resource` is not one of them, so the redirect here arrives
 * without it — and the policy in front of the authorize endpoint refuses a
 * request that lacks it (`lib/auth/mcpOAuthPolicy.ts`). The request that got
 * this far already passed that check, and there is exactly one value it can have
 * passed with, so that value is restored rather than read from the URL.
 */
export function oauthAuthorizeNext(params: URLSearchParams): string | null {
  if (!isOAuthAuthorizeHandoff(params)) return null;
  const query = new URLSearchParams(params);
  for (const name of SIGNING_PARAMS) query.delete(name);
  query.delete('next');
  query.set('resource', mcpResourceUrl());
  const prompt = query
    .get('prompt')
    ?.split(' ')
    .filter((p) => p && p !== 'login' && p !== 'create')
    .join(' ');
  if (prompt) query.set('prompt', prompt);
  else query.delete('prompt');
  return `${AUTH_BASE_PATH}/oauth2/authorize?${query.toString()}`;
}

/**
 * The `client_id` of the authorize request a sign-in `next` returns to, or null
 * when `next` is anything else. The sign-in card uses it to say WHICH app is
 * waiting (design Panel 5) — display only: the authorize endpoint re-validates
 * the whole request after sign-in.
 */
export function authorizeNextClientId(next: string | null | undefined): string | null {
  if (!next) return null;
  const prefix = `${AUTH_BASE_PATH}/oauth2/authorize?`;
  if (!next.startsWith(prefix)) return null;
  return new URLSearchParams(next.slice(prefix.length)).get('client_id') || null;
}
