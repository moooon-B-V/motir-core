import { describe, expect, it } from 'vitest';
import {
  CIMD_FETCH_POLICY,
  fetchClientMetadataDocument,
  setClientMetadataTransportForTests,
} from '@/lib/oauth/clientMetadataDocument';
import { CIMD_DISCOVERY_ID, discoveredClientHost } from '@/lib/oauth/discoveredClient';
import { oauthErrorPageUrl } from '@/lib/oauth/config';

// The Client ID Metadata Document seams (Story MOTIR-7170 · Subtask MOTIR-7173):
// the transport the plugin fetches with, the host a discovered client is
// verified as, and the refused-request URL a bad document lands on. The flow
// itself is `tests/integration/oauth/clientMetadataDocument.test.ts`.

describe('the metadata transport', () => {
  // These reach the REAL `@better-auth/cimd/node` transport, and still never the
  // network: an IP literal resolves to itself and `localhost` from the hosts
  // file, and the transport refuses either answer before it opens a socket.
  it.each(['https://10.0.0.5/meta', 'https://127.0.0.1/meta', 'https://localhost/meta'])(
    'refuses a host that resolves to a non-public address: %s',
    async (url) => {
      await expect(fetchClientMetadataDocument(url, {})).rejects.toThrow(/public-routable/);
    },
  );

  it('refuses anything but HTTPS', async () => {
    await expect(fetchClientMetadataDocument('http://claude.ai/meta', {})).rejects.toThrow(/HTTPS/);
  });

  it('is swapped by the test seam, and restored by passing null', async () => {
    setClientMetadataTransportForTests(async () => new Response('{}', { status: 200 }));
    expect((await fetchClientMetadataDocument('https://10.0.0.5/meta', {})).status).toBe(200);
    setClientMetadataTransportForTests(null);
    await expect(fetchClientMetadataDocument('https://10.0.0.5/meta', {})).rejects.toThrow(
      /public-routable/,
    );
  });

  it('bounds fetches below the plugin’s defaults', () => {
    expect(CIMD_FETCH_POLICY.maximumConcurrentFetchesPerOrigin).toBeLessThan(4);
    expect(CIMD_FETCH_POLICY.maximumFetchesPerMinute).toBeLessThan(120);
  });
});

describe('discoveredClientHost', () => {
  it('is the client_id URL’s host for a discovered client', () => {
    expect(
      discoveredClientHost({
        clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
        clientDiscoveryId: CIMD_DISCOVERY_ID,
      }),
    ).toBe('claude.ai');
  });

  it('is null for a registered client, whatever its id looks like', () => {
    expect(discoveredClientHost({ clientId: 'https://claude.ai/x', clientDiscoveryId: null })).toBe(
      null,
    );
    expect(discoveredClientHost({ clientId: 'mcp_7Qx' })).toBe(null);
  });

  it('is null for a discovered id that is not a URL', () => {
    expect(discoveredClientHost({ clientId: 'not a url', clientDiscoveryId: 'cimd' })).toBe(null);
  });
});

describe('oauthErrorPageUrl', () => {
  it('carries a refused document’s host and reason as display data', () => {
    const url = new URL(oauthErrorPageUrl('client_metadata', 'evil.example', 'not JSON'));
    expect(url.pathname).toBe('/oauth/error');
    expect(url.searchParams.get('error')).toBe('client_metadata');
    expect(url.searchParams.get('host')).toBe('evil.example');
    expect(url.searchParams.get('detail')).toBe('not JSON');
  });

  it('leaves out what it was not given', () => {
    const url = new URL(oauthErrorPageUrl('invalid_client'));
    expect([...url.searchParams.keys()]).toEqual(['error']);
  });
});
