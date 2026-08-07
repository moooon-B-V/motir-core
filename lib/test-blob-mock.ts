// Node-only object-store fake for E2E (Subtask 5.2.8; moved onto the S3 API by
// MOTIR-2389).
//
// CI's Playwright lane runs with placeholder blob credentials — "no E2E
// performs a real upload (the real credentials live on the platform)" is the
// standing ci.yml decision — so the attachments journey (tests/e2e/
// attachments.spec.ts) needs a seam that lets the app upload through its real
// route with no real store. The SERVER-side put/head/get/delete calls land
// here; the BROWSER-side reads of the returned URLs (thumbnails, the lightbox,
// downloads) are fulfilled by the spec's own `page.route` — nothing ever leaves
// localhost.
//
// ⚠️ THIS IS NOT AN UNDICI MOCK, and that is the whole point.
//
// Every other E2E seam here (OAuth, billing, GitHub) intercepts an undici
// `MockAgent` installed as the global dispatcher. That mechanism CANNOT reach
// the object store: undici's dispatcher governs `fetch`, and the AWS SDK's
// default Node transport is `node:https`. `@vercel/blob` used `fetch`, so the
// interception worked; moving to the S3 SDK silently relocated the traffic to a
// layer the interceptor does not see, and the suite's uploads left as real DNS
// lookups (`getaddrinfo ENOTFOUND e2e.s3.invalid`) — passing locally, failing in
// CI, and surfacing as "the attachment list has one row instead of two."
//
// So the fake is installed at the SDK's OWN transport seam
// (`installObjectStoreTransport`), where nothing can route around it, and it
// never touches the network at all. The configured endpoint host is therefore
// irrelevant and unreachable BY DESIGN.

import { Readable } from 'node:stream';
import { installObjectStoreTransport } from '@/lib/blob/s3';

interface StoredObject {
  body: Buffer;
  contentType: string;
}

/** The store, keyed by `<bucket>/<key>` — one Map per server boot. */
const stored = new Map<string, StoredObject>();

/** The shape the SDK hands its transport: a serialized, signed request. */
interface TransportRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function objectId(path: string): string {
  const [withoutQuery] = path.split('?');
  return decodeURIComponent(withoutQuery ?? '').replace(/^\/+/, '');
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.alloc(0);
}

/** The SDK's body collector pipes what it is given, so this must be a real Node
 *  `Readable` — an async iterable is not enough (`nodeStream.pipe is not a
 *  function`). */
function bodyStream(bytes: Buffer): Readable {
  return Readable.from(bytes.length > 0 ? [bytes] : []);
}

/**
 * The in-process transport. PUT stores the bytes; HEAD/GET answer from what was
 * stored (404 when absent, which is what `headPrivateBlob` turns into null);
 * DELETE is idempotent — the same contract the real store gives us.
 */
export function createObjectStoreTransport() {
  return {
    async handle(request: TransportRequest) {
      const id = objectId(request.path);
      const headers = request.headers ?? {};
      const empty = () => bodyStream(Buffer.alloc(0));

      if (request.method === 'PUT') {
        stored.set(id, {
          body: toBuffer(request.body),
          contentType: headers['content-type'] ?? 'application/octet-stream',
        });
        return {
          response: { statusCode: 200, reason: 'OK', headers: { etag: '"e2e"' }, body: empty() },
        };
      }

      if (request.method === 'DELETE') {
        stored.delete(id);
        return {
          response: { statusCode: 204, reason: 'No Content', headers: {}, body: empty() },
        };
      }

      const object = stored.get(id);
      if (!object) {
        return {
          response: { statusCode: 404, reason: 'Not Found', headers: {}, body: empty() },
        };
      }
      return {
        response: {
          statusCode: 200,
          reason: 'OK',
          headers: {
            'content-length': String(object.body.length),
            'content-type': object.contentType,
            etag: '"e2e"',
          },
          body: bodyStream(request.method === 'HEAD' ? Buffer.alloc(0) : object.body),
        },
      };
    },
  };
}

/** Wire the fake store into the S3 client. Called once, at instrumentation. */
export function installBlobStoreMock(): void {
  stored.clear();
  installObjectStoreTransport(createObjectStoreTransport());
}
