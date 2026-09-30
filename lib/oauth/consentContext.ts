import { AsyncLocalStorage } from 'node:async_hooks';

// The CONNECTION a consent decision is being recorded for (Story MOTIR-6973 ·
// Subtask MOTIR-6983).
//
// `@better-auth/oauth-provider` asks one question of its host when a person
// approves — `postLogin.consentReferenceId`, "what value should this consent,
// and every code and token minted from it, carry?" — and asks it from inside
// its own endpoint, where Motir's arguments are out of reach. The answer is the
// id of the `api_token` row `oauthConnectionsService.approveConsent` has just
// written, so the service runs the provider's consent call INSIDE this scope and
// the callback reads it back out. Scoped per call by `AsyncLocalStorage`, so two
// people approving at the same moment can never read each other's connection.
//
// Outside the scope there is no connection, and that is load-bearing twice over:
// the policy plugin refuses an ACCEPTING consent that did not come through the
// service (`lib/auth/mcpOAuthPolicy.ts`), and at `/oauth2/authorize` the
// callback answers {@link CONSENT_REQUIRED_REFERENCE}, which no consent row can
// ever carry, so the person is always sent to the consent screen to pick a
// workspace — a remembered consent would otherwise mint a code bound to nothing.

const storage = new AsyncLocalStorage<{ connectionId: string }>();

/**
 * The reference the provider is given when no approval is in progress. It names
 * no `api_token` row (the foreign key would refuse a consent carrying it, and the
 * policy plugin refuses the request before that), so a consent lookup keyed on it
 * finds nothing and the provider asks again.
 */
export const CONSENT_REQUIRED_REFERENCE = 'motir:consent-required';

/** Run `fn` with `connectionId` as the connection the provider's consent binds to. */
export function withConsentConnection<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ connectionId }, fn);
}

/** The connection an in-progress approval is binding, or null outside one. */
export function currentConsentConnection(): string | null {
  return storage.getStore()?.connectionId ?? null;
}
