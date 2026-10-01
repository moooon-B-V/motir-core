import type { OAuthClientVerification } from '@/lib/dto/oauthConnections';

// Which clients Motir DISCOVERED by a Client ID Metadata Document (MOTIR-7173)
// rather than had registered, and the host that vouches for each. Pure, so the
// mappers and services can read it without importing the fetch transport
// (`./clientMetadataDocument.ts`).

/** The provenance the cimd plugin stamps on a client it discovered (`clientDiscoveryId`). */
export const CIMD_DISCOVERY_ID = 'cimd';

/**
 * The HOST that vouches for a discovered client — its `client_id` URL's — or
 * null for a client that was registered (by DCR or by a person). This is the
 * fact the consent screen and Connected apps show as verified.
 */
export function discoveredClientHost(client: {
  clientId: string;
  clientDiscoveryId?: string | null;
}): string | null {
  if (client.clientDiscoveryId !== CIMD_DISCOVERY_ID) return null;
  try {
    return new URL(client.clientId).host || null;
  } catch {
    return null;
  }
}

/**
 * Who vouches for a client (MOTIR-7174), from MOTIR'S OWN RECORD of it and
 * nothing the client says about itself: `userId` is set only when a signed-in
 * person registered it, and `clientDiscoveryId` only when the cimd plugin
 * fetched and validated its document. A discovered client whose `client_id`
 * somehow has no host falls to `self` rather than claiming a domain.
 */
export function clientVerification(client: {
  clientId: string;
  clientDiscoveryId?: string | null;
  userId?: string | null;
}): OAuthClientVerification {
  const host = discoveredClientHost(client);
  if (host) return { kind: 'domain', host };
  if (client.userId) return { kind: 'registered' };
  return { kind: 'self' };
}
