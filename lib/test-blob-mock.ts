// Node-only object-store mock for E2E (Subtask 5.2.8; moved onto the S3 API by
// MOTIR-2389).
//
// CI's Playwright lane runs with placeholder blob credentials — "no E2E
// performs a real upload (the real credentials live on the platform)" is the
// standing ci.yml decision — so the attachments journey (tests/e2e/
// attachments.spec.ts) needs the SAME seam the Google OAuth flow already uses:
// an undici intercept installed by instrumentation.ts behind an E2E_TEST_BLOB=1
// env gate, dormant everywhere else. The SERVER-side put/head/delete calls land
// here; the BROWSER-side reads of the returned URLs (thumbnails, the lightbox,
// downloads) are fulfilled by the spec's own `page.route` — nothing ever leaves
// localhost.
//
// What changed with the provider swap, and what deliberately did not:
//   - The intercepted HOST is now the S3 endpoint (MOTIR_S3_ENDPOINT) rather
//     than the Vercel Blob API. `lib/blob/s3.ts` uses `forcePathStyle`, so every
//     request is `<endpoint>/<bucket>/<key>` — ONE host to intercept, and the
//     bucket is readable off the path.
//   - The SIGNING calls make no network request at all now (an S3 presigned URL
//     is derived client-side), so there is nothing left to intercept for them.
//     `signedDownloadUrl` still short-circuits to the mock public host under
//     E2E_TEST_BLOB so the specs' existing `page.route` globs keep matching;
//     re-pointing those belongs to the story's E2E card (MOTIR-2395).
//
// The shared MockAgent comes from instrumentation.ts (ONE global dispatcher
// serves both this and the OAuth mock — a second setGlobalDispatcher would
// silently disconnect the first).

import type { MockAgent } from 'undici';

/** Objects this process has "stored", keyed by `<bucket>/<key>` — so a HEAD
 * after a PUT reports the real size + content type the register step reads. */
const stored = new Map<string, { size: number; contentType: string }>();

// The random key suffix is applied by `lib/blob/uploader.ts` itself now (S3
// stores exactly the key it is given), so the mock no longer invents one — it
// records whatever key the real code produced, which is what makes the HEAD
// truthful about the object the app believes it wrote.

function objectId(path: string): string {
  const [withoutQuery] = path.split('?');
  return (withoutQuery ?? '').replace(/^\/+/, '');
}

export function installBlobStoreMock(agent: MockAgent): void {
  const endpoint = process.env['MOTIR_S3_ENDPOINT'] ?? 'https://e2e.s3.invalid';
  const pool = agent.get(endpoint);

  // PUT /<bucket>/<key> — the server-side upload (putPrivateAttachment /
  // putPublicAsset). Records the size so a later HEAD is truthful.
  pool
    .intercept({ path: () => true, method: 'PUT' })
    .reply((req) => {
      const body = req.body;
      const size =
        typeof body === 'string'
          ? Buffer.byteLength(body)
          : Buffer.isBuffer(body)
            ? body.length
            : 0;
      const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
      const raw = headers['content-type'] ?? headers['Content-Type'];
      stored.set(objectId(req.path), {
        size,
        contentType: (Array.isArray(raw) ? raw[0] : raw) ?? 'application/octet-stream',
      });
      return { statusCode: 200, data: '', responseOptions: { headers: { etag: '"e2e"' } } };
    })
    .persist();

  // HEAD /<bucket>/<key> — the register step's authoritative metadata read.
  // An object this process never stored is genuinely absent (404), which is
  // what `headPrivateBlob` turns into null.
  pool
    .intercept({ path: () => true, method: 'HEAD' })
    .reply((req) => {
      const meta = stored.get(objectId(req.path));
      if (!meta) return { statusCode: 404, data: '' };
      return {
        statusCode: 200,
        data: '',
        responseOptions: {
          headers: {
            'content-length': String(meta.size),
            'content-type': meta.contentType,
          },
        },
      };
    })
    .persist();

  // DELETE /<bucket>/<key> — idempotent, exactly like the real delete-object.
  pool
    .intercept({ path: () => true, method: 'DELETE' })
    .reply((req) => {
      stored.delete(objectId(req.path));
      return { statusCode: 204, data: '' };
    })
    .persist();
}
