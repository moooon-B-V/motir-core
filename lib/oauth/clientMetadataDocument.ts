import type { CimdMetadataFetchPolicy } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';

// OAuth Client ID Metadata Documents (MOTIR-7173, Story MOTIR-7170). A client may
// identify itself by an HTTPS URL as its `client_id`; the `@better-auth/cimd`
// plugin fetches the JSON document at that URL, validates it, and records the
// client. Hosted Claude is `https://claude.ai/oauth/mcp-oauth-client-metadata`
// and Claude Code `https://claude.ai/oauth/claude-code-client-metadata`; Claude
// selects this path only once the authorization-server metadata advertises
// `client_id_metadata_document_supported` (which the plugin's discovery adds).
//
// There is NO domain allowlist: any HTTPS host may identify itself. What Motir
// can then vouch for is that HOST — the consent screen names it, never the
// document's self-asserted `client_name`.

/**
 * Fetch budgets. Each limit refuses immediately (`temporarily_unavailable`)
 * rather than queueing, and they are per server instance.
 */
export const CIMD_FETCH_POLICY: CimdMetadataFetchPolicy = {
  // A document that just failed is not fetched again for every retry click: the
  // person sees the refusal page, and a broken document stays broken for 5s.
  minimumFetchInterval: 5,
  // The fetch is a door to the network that anyone can open by naming a URL, so
  // in-flight fetches are bounded well below what would tie up the instance.
  maximumConcurrentFetches: 8,
  maximumConcurrentFetchesPerOrigin: 2,
  // A successful document is cached (below), so a real client costs one fetch
  // per interval; these caps only bite on a flood of distinct client_id URLs.
  maximumFetchesPerMinute: 60,
  maximumFetchesPerOriginPerMinute: 20,
};

/**
 * How long a validated document is trusted before the next sign-in re-fetches
 * it (an HTTP `Cache-Control` shorter than this wins). 30 minutes: a change the
 * publisher makes — a redirect URI withdrawn — takes effect within the half
 * hour, while a busy client is still fetched at most twice an hour per instance.
 */
export const CIMD_REVALIDATION_INTERVAL = '30m';

type Fetcher = typeof fetchClientMetadataResource;

let transport: Fetcher = fetchClientMetadataResource;

/**
 * The transport the plugin fetches documents with: `@better-auth/cimd/node`'s,
 * which validates HTTPS, resolves the host ONCE and refuses any non-public
 * answer (RFC 6890 special-use), pins that address for the connection, never
 * follows a redirect, and caps size and time. A hand-rolled fetch could not pin
 * the address after resolving it, which is the SSRF guard that matters.
 */
export const fetchClientMetadataDocument: Fetcher = (url, init) => transport(url, init);

/** Tests only: swap the network for a stub, so no test ever reaches it. */
export function setClientMetadataTransportForTests(fetcher: Fetcher | null): void {
  transport = fetcher ?? fetchClientMetadataResource;
}
