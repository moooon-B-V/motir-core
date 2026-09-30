import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { mcpResourceUrl } from '@/lib/oauth/config';
import { isAllowedRedirectUri, matchesRegisteredRedirect } from '@/lib/oauth/redirectPolicy';
import { currentConsentConnection } from '@/lib/oauth/consentContext';

// Motir's policy IN FRONT OF `@better-auth/oauth-provider` (MOTIR-6982).
//
// The provider implements the RFCs; it does not know that Motir protects exactly
// one resource or which redirects Motir will honour. Two checks it cannot express
// through its options run here, as `before` hooks on its own endpoints, so they
// hold on every request whichever door it came through:
//
//   1. REGISTRATION (RFC 7591) — every `redirect_uris` entry must be `https` or
//      loopback `http` (`lib/oauth/redirectPolicy.ts`). The provider's schema also
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
            const body = (ctx.body ?? {}) as { redirect_uris?: unknown };
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
          }),
        },
        {
          matcher: (ctx) => ctx.path === AUTHORIZE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const query = (ctx.query ?? {}) as Record<string, string | undefined>;
            if (query.resource === mcpResourceUrl()) return;

            const description = query.resource
              ? `resource must be ${mcpResourceUrl()}`
              : 'resource is required';
            const clientId = query.client_id;
            const redirectUri = query.redirect_uri;
            const client =
              clientId && redirectUri
                ? await ctx.context.adapter.findOne<RegisteredClient>({
                    model: 'oauthClient',
                    where: [{ field: 'clientId', value: clientId }],
                  })
                : null;
            const target =
              client &&
              redirectUri &&
              matchesRegisteredRedirect(client.redirectUris ?? [], redirectUri)
                ? errorUrl(redirectUri, {
                    error: 'invalid_target',
                    error_description: description,
                    state: query.state,
                    iss: ctx.context.baseURL,
                  })
                : errorUrl(`${ctx.context.baseURL}/error`, {
                    error: 'invalid_target',
                    error_description: description,
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
