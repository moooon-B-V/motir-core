// Next.js instrumentation hook (Next 13.4+).
//
// Runs ONCE per Node.js server boot, before any handler runs. The default
// build does nothing; the only side effects are env-gated E2E seams:
//
//   - E2E_TEST_OAUTH=1 → lib/test-oauth-mock intercepts outbound HTTPS calls
//     to Google's OAuth token endpoint and returns a synthetic id_token, so
//     Playwright drives the real Better-Auth callback handler end-to-end
//     without leaving localhost.
//   - E2E_TEST_BLOB=1 → lib/test-blob-mock intercepts the @vercel/blob SDK's
//     API calls (put/del) and returns synthetic public-store URLs, so the
//     attachments E2E journey performs real uploads through the real route
//     without a real blob store (CI runs a placeholder token by design).
//
// Both mocks share ONE undici MockAgent (lib/test-mock-agent) installed as
// the global dispatcher — installing two agents would silently disconnect
// the first mock's intercepts (only the last setGlobalDispatcher wins).
//
// Why dynamic import to separate modules: Next compiles instrumentation.ts
// for BOTH Node and Edge runtimes. A static `import 'undici'` or
// `import 'node:crypto'` at the top of this file would make the Edge
// bundler emit "node module in edge runtime" errors. Dynamic-importing the
// node-only helpers from inside an `if (NEXT_RUNTIME === 'nodejs')` block
// hides those imports from the edge analysis entirely.
//
// Production safety: the env-gates keep these code paths completely dormant
// outside the Playwright run — `register()` returns immediately when neither
// flag is set.

export async function register() {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const wantOauthMock = process.env['E2E_TEST_OAUTH'] === '1';
  const wantBlobMock = process.env['E2E_TEST_BLOB'] === '1';
  if (!wantOauthMock && !wantBlobMock) return;

  const { installSharedMockAgent } = await import('@/lib/test-mock-agent');
  const agent = installSharedMockAgent();

  if (wantOauthMock) {
    const { installGoogleTokenMock } = await import('@/lib/test-oauth-mock');
    installGoogleTokenMock(agent);
    // eslint-disable-next-line no-console -- instrumentation boot is the right place for this signal
    console.log('[INSTRUMENT] E2E_TEST_OAUTH active — Google token endpoint mocked.');
  }
  if (wantBlobMock) {
    const { installBlobStoreMock } = await import('@/lib/test-blob-mock');
    installBlobStoreMock(agent);
    // eslint-disable-next-line no-console -- instrumentation boot is the right place for this signal
    console.log('[INSTRUMENT] E2E_TEST_BLOB active — Vercel Blob API mocked.');
  }
}
