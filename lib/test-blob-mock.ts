// Node-only Vercel Blob API mock for E2E (Subtask 5.2.8).
//
// CI's Playwright lane runs with a placeholder BLOB_READ_WRITE_TOKEN — "no
// E2E performs a real upload (the real token lives in Vercel)" is the
// standing ci.yml decision — so the attachments journey (tests/e2e/
// attachments.spec.ts) needs the SAME seam the Google OAuth flow already
// uses: an undici intercept installed by instrumentation.ts behind an
// E2E_TEST_BLOB=1 env gate, dormant everywhere else. The SERVER-side
// `put`/`del` calls land here; the BROWSER-side reads of the returned
// public URLs (thumbnails, the lightbox, downloads) are fulfilled by the
// spec's own `page.route` — nothing ever leaves localhost.
//
// What the mock does:
//   - Intercepts the @vercel/blob SDK's API host (https://vercel.com,
//     paths under /api/blob — see the SDK's defaultVercelBlobApiUrl).
//   - PUT /api/blob/?pathname=… (uploadAttachment → putAttachment) replies
//     with a PutBlobResult whose `url` rides the REAL public-host suffix
//     (.public.blob.vercel-storage.com, the suffix lib/blob/referencedUrls
//     recognises) with an addRandomSuffix-style infix so same-named uploads
//     never collide — mirroring the store contract the services rely on.
//   - POST /api/blob/delete (deleteAttachmentBlob) replies 200 — idempotent
//     on already-gone URLs, exactly like the real `del`.
//
// The shared MockAgent comes from instrumentation.ts (ONE global dispatcher
// serves both this and the OAuth mock — a second setGlobalDispatcher would
// silently disconnect the first).

import type { MockAgent } from 'undici';

/** The store id the synthetic public URLs carry (any value works — the spec's
 * page.route matches the suffix, and the URL parser only checks the suffix). */
const MOCK_STORE_HOST = 'https://e2etest.public.blob.vercel-storage.com';

let urlSeq = 0;

/** `shot.png` → `shot-e2e7.png` — the addRandomSuffix shape (infix, so the
 * extension survives for the spec's content-type-by-extension fulfiller). */
function withSuffix(pathname: string): string {
  urlSeq += 1;
  const dot = pathname.lastIndexOf('.');
  if (dot <= pathname.lastIndexOf('/')) return `${pathname}-e2e${urlSeq}`;
  return `${pathname.slice(0, dot)}-e2e${urlSeq}${pathname.slice(dot)}`;
}

export function installBlobStoreMock(agent: MockAgent): void {
  const pool = agent.get('https://vercel.com');

  pool
    .intercept({
      path: (path) => path.startsWith('/api/blob') && !path.startsWith('/api/blob/delete'),
      method: 'PUT',
    })
    .reply((req) => {
      const query = req.path.includes('?') ? req.path.slice(req.path.indexOf('?') + 1) : '';
      const pathname = new URLSearchParams(query).get('pathname') ?? 'unnamed';
      const url = `${MOCK_STORE_HOST}/${withSuffix(pathname)}`;
      return {
        statusCode: 200,
        data: {
          url,
          downloadUrl: `${url}?download=1`,
          pathname,
          contentType: 'application/octet-stream',
          contentDisposition: 'attachment',
        },
        responseOptions: { headers: { 'content-type': 'application/json' } },
      };
    })
    .persist();

  pool
    .intercept({ path: (path) => path.startsWith('/api/blob/delete'), method: 'POST' })
    .reply(200, {}, { headers: { 'content-type': 'application/json' } })
    .persist();

  // Private-attachment signing (MOTIR-1665): `signedDownloadUrl` calls
  // `issueSignedToken` (POST /api/blob/signed-token) then builds the presigned
  // URL locally. Reply with synthetic delegation material so the server-side
  // signing flow completes off-network; the E2E's own `page.route` fulfils the
  // resulting object-host fetch. (The acceptance E2E — MOTIR-1670 — exercises
  // this end-to-end and refines it if the delegation shape needs more.)
  pool
    .intercept({ path: (path) => path.startsWith('/api/blob/signed-token'), method: 'POST' })
    .reply(
      200,
      {
        clientSigningToken: 'e2e-client-signing-token',
        delegationToken: 'e2e-delegation-token',
        validUntil: 4102444800000, // 2100-01-01, comfortably in the future
      },
      { headers: { 'content-type': 'application/json' } },
    )
    .persist();
}
