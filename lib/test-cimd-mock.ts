// The E2E lane's Client ID Metadata Document seam (Story MOTIR-7170 · Subtask
// MOTIR-7176). Installed from `lib/test-mock-seams.ts` behind `E2E_TEST_CIMD=1`.
//
// WHY A SEAM, NOT A SEEDED ROW ALONE. The cimd plugin re-resolves a discovered
// client on every authorize whose document is not in its IN-MEMORY cache, and a
// freshly booted server's cache is empty — so a row seeded into the database is
// fetched again regardless. The fetch goes through the hardened transport, which
// refuses any special-use address, so a fixture server on 127.0.0.1 cannot answer
// it, and `page.route()` cannot reach a server-side fetch at all. This replaces
// the TRANSPORT, and only that: the plugin still validates every document, and
// Motir's policy hook still decides, exactly as for a real client.
//
// The documents are a fixed table — no fixture file, so nothing here makes the
// output-file tracer follow a dynamic path (see `lib/test-fixture-file.ts`).
// Claude's two mirror what claude.ai publishes (read 2026-10-01); the third is
// a document that calls itself "Claude" from another host, the case the
// verified-by-domain design exists for. Any other URL is unreachable.

import { setClientMetadataTransportForTests } from '@/lib/oauth/clientMetadataDocument';

export const E2E_CIMD_DOCUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
  'https://claude.ai/oauth/mcp-oauth-client-metadata': {
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    client_name: 'Claude',
    client_uri: 'https://claude.ai',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  'https://claude.ai/oauth/claude-code-client-metadata': {
    client_id: 'https://claude.ai/oauth/claude-code-client-metadata',
    client_name: 'Claude Code',
    client_uri: 'https://claude.ai',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  'https://example.org/client': {
    client_id: 'https://example.org/client',
    client_name: 'Claude',
    client_uri: 'https://example.org',
    redirect_uris: ['https://example.org/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
};

export function installClientMetadataDocumentMock(): void {
  setClientMetadataTransportForTests(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const document = E2E_CIMD_DOCUMENTS[url];
    if (!document) throw new TypeError(`fetch failed: no E2E document at ${url}`);
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}
