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
