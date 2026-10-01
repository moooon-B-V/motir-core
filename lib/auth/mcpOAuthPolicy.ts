import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { mcpResourceUrl, oauthErrorPageUrl } from '@/lib/oauth/config';
import {
  isAllowedRedirectUri,
  isLoopbackRedirect,
  matchesRegisteredRedirect,
} from '@/lib/oauth/redirectPolicy';
import { currentConsentConnection } from '@/lib/oauth/consentContext';

// Motir's policy IN FRONT OF `@better-auth/oauth-provider` (MOTIR-6982).
//
// The provider implements the RFCs; it does not know that Motir protects exactly
// one resource or which redirects Motir will honour. Two checks it cannot express
// through its options run here, as `before` hooks on its own endpoints, so they
// hold on every request whichever door it came through:
//
//   1. REGISTRATION (RFC 7591) — every `redirect_uris` entry must be `https` or
//      loopback `http` (`lib/oauth/redirectPolicy.ts`), and a registration whose
//      redirects are ALL loopback is declared `application_type: native` when it
//      named none, which is what better-auth 1.7 needs to accept them. The provider's schema also
//      admits custom schemes, which any installed app can claim, and so would
//      hand an authorization code to whoever registered the scheme first.
//      Refused `invalid_redirect_uri`, the RFC 7591 §3.2.2 code.
//   2. AUTHORIZATION (RFC 8707) — `resource` is REQUIRED and must be the MCP's
//      URL. The provider checks `resource` only at the token endpoint, and only
//      when one is sent, so without this a code could be minted for no resource
//      or for any. Refused `invalid_target`: back to the client's redirect when
//      that redirect is one the client registered (RFC 6749 §4.1.2.1), and to
//      Better-Auth's error page otherwise — an unverified redirect is never
//      followed, which is the open-redirect rule.
//      BEFORE that, a request whose CLIENT is unknown or disabled, or whose
//      `redirect_uri` that client never registered, is shown Motir's own
//      refused-request page (`/oauth/error`, MOTIR-6985) — the one state with no
//      trustworthy address to send an error to. The provider would refuse both
//      too, to Better-Auth's bare `/api/auth/error`; this says it in words.
//   3. CONSENT (MOTIR-6983) — an ACCEPTING `/oauth2/consent` is honoured only
//      from inside `oauthConnectionsService.approveConsent`, which has recorded
//      the connection (workspace, project, grant) the consent binds to. Posted
//      directly, it would mint a code bound to nothing, so it is refused
//      `access_denied`. Declining writes nothing and stays open to anyone.
//
// PKCE (S256 only, `plain` refused) is the provider's own: public clients always
// require it, and its query schema rejects any method but `S256`.

const REGISTER_PATH = '/oauth2/register';
const AUTHORIZE_PATH = '/oauth2/authorize';
const CONSENT_PATH = '/oauth2/consent';

interface RegisteredClient {
  redirectUris?: string[] | null;
  disabled?: boolean | null;
}

function hostOf(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

function refusedRegistration(description: string): APIError {
  return new APIError('BAD_REQUEST', {
    error: 'invalid_redirect_uri',
    error_description: description,
  });
}

function errorUrl(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [name, value] of Object.entries(params)) {
    if (value) url.searchParams.set(name, value);
  }
  return url.toString();
}

// Annotated, not inferred: the inferred type names `better-call`, which this
// module does not import, and the app's declaration emit refuses it (TS2742 —
// the same reason `authOptions` in ./index.ts is annotated).
export function mcpOAuthPolicy(): BetterAuthPlugin {
  return {
    id: 'mcp-oauth-policy',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === REGISTER_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as {
              redirect_uris?: unknown;
              application_type?: unknown;
            };
            const uris = body.redirect_uris;
            if (!Array.isArray(uris)) return; // the provider's own schema answers this
            const refused = uris.find(
              (uri) => typeof uri !== 'string' || !isAllowedRedirectUri(uri),
            );
            if (refused !== undefined) {
              throw refusedRegistration(
                'redirect_uris must use https, or http on a loopback host (localhost, 127.0.0.1, [::1])',
              );
            }
            // better-auth 1.7 validates a redirect against the client's
            // `application_type`, defaulting an absent one to `web` (OpenID DCR),
            // and a `web` client may not register a loopback `http` redirect. A
            // native MCP client — Claude Code, any CLI — registers exactly that and
            // usually sends no `application_type`, so on 1.7 it would be refused
            // where 1.6.11 registered it (MOTIR-7171). A registration whose every
            // redirect is loopback IS a native client (RFC 8252 §7.3), so it is
            // declared one; anything the caller stated is left as stated.
            if (
              body.application_type === undefined &&
              uris.length > 0 &&
              uris.every(isLoopbackRedirect)
            ) {
              return { context: { body: { ...body, application_type: 'native' } } };
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === AUTHORIZE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const query = (ctx.query ?? {}) as Record<string, string | undefined>;
            const clientId = query.client_id;
            const redirectUri = query.redirect_uri;
            const client = clientId
              ? await ctx.context.adapter.findOne<RegisteredClient>({
                  model: 'oauthClient',
                  where: [{ field: 'clientId', value: clientId }],
                })
              : null;
            if (!client || client.disabled) {
              throw ctx.redirect(oauthErrorPageUrl('invalid_client'));
            }
            const redirectTrusted =
              !!redirectUri && matchesRegisteredRedirect(client.redirectUris ?? [], redirectUri);
            if (!redirectTrusted) {
              throw ctx.redirect(oauthErrorPageUrl('invalid_redirect', hostOf(redirectUri)));
            }
            if (query.resource === mcpResourceUrl()) return;

            const description = query.resource
              ? `resource must be ${mcpResourceUrl()}`
              : 'resource is required';
            // The redirect is the client's own, checked above: the refusal goes
            // back to it (RFC 6749 §4.1.2.1).
            const target = errorUrl(redirectUri!, {
              error: 'invalid_target',
              error_description: description,
              state: query.state,
              iss: ctx.context.baseURL,
            });
            throw ctx.redirect(target);
          }),
        },
        {
          matcher: (ctx) => ctx.path === CONSENT_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { accept?: unknown };
            if (body.accept !== true) return; // a refusal records nothing
            if (currentConsentConnection() !== null) return;
            throw new APIError('FORBIDDEN', {
              error: 'access_denied',
              error_description: 'Consent is recorded through the Motir consent screen',
            });
          }),
        },
      ],
    },
  };
}
