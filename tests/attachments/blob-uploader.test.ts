import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';

/** The shape the transport receives: a fully serialized, fully SIGNED request.
 *  Declared structurally so the test needs no direct `@smithy/*` dependency. */
interface SignedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

// The two-bucket blob adapter, on the S3 API (MOTIR-2389).
//
// ⚠️ This suite deliberately does NOT mock the SDK. It runs the REAL
// `@aws-sdk/client-s3` — real request serialization, real SigV4 signing, real
// presigning — and fakes only the HTTP layer, by swapping the client's
// `requestHandler` for one that records the fully-signed request and answers it.
//
// That is the difference between asserting our own call and asserting the
// artefact: a mocked SDK would happily agree that we "passed the right options"
// while the request it produced targeted the wrong bucket or carried an unsigned
// content type. `notes.html` #207 is the incident where exactly that gap — a
// stand-in that agreed with the code by construction — stored objects a later
// reader refused forever. Here the assertions read the wire.

const ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.test.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'test-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.test.invalid/motir-public',
} as const;

const {
  putAttachment,
  putPublicAsset,
  putPrivateAttachment,
  signedDownloadUrl,
  mintPrivateUploadToken,
  headPrivateBlob,
  deleteAttachmentBlob,
  deletePublicAsset,
} = await import('@/lib/blob/uploader');
const { s3Client, resetS3ClientForTests } = await import('@/lib/blob/s3');

/** What the fake transport hands back — the SDK deserializes it as a response. */
interface FakeTransportResult {
  response: {
    statusCode: number;
    reason: string;
    headers: Record<string, string>;
    body: Readable;
  };
}

interface Seen {
  method: string;
  bucket: string;
  key: string;
  headers: Record<string, string>;
  body: unknown;
}

let seen: Seen[] = [];
/** Per-request canned responses, keyed by `<METHOD> <bucket>/<key>`. */
let responses: Map<string, { statusCode: number; headers?: Record<string, string> }>;

/**
 * Replace the client's transport. Everything above it — serialization, the
 * SigV4 signer, the error deserializer — is the SDK's own.
 */
function installFakeTransport(): void {
  const client = s3Client();
  client.config.requestHandler = {
    async handle(request: SignedRequest): Promise<FakeTransportResult> {
      const [, bucket = '', ...rest] = request.path.split('/');
      const key = decodeURIComponent(rest.join('/'));
      seen.push({
        method: request.method,
        bucket,
        key,
        headers: request.headers,
        body: request.body,
      });
      const canned = responses.get(`${request.method} ${bucket}/${key}`) ?? { statusCode: 200 };
      return {
        response: {
          statusCode: canned.statusCode,
          reason: '',
          headers: { etag: '"abc"', ...(canned.headers ?? {}) },
          body: Readable.from([]),
        },
      };
    },
  } as unknown as typeof client.config.requestHandler;
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) process.env[name] = value;
  resetS3ClientForTests();
  seen = [];
  responses = new Map();
  installFakeTransport();
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
  delete process.env['E2E_TEST_BLOB'];
  resetS3ClientForTests();
  vi.restoreAllMocks();
});

/** `avatars/u1/a-3f9c1d2e4b.png` → the stable part, so a random suffix is assertable. */
function withoutSuffix(key: string): string {
  return key.replace(/-[0-9a-f]{10}(\.[^.]+)?$/, '$1');
}

describe('the two-bucket split — every path writes the bucket it should', () => {
  it('putPublicAsset writes the PUBLIC bucket and returns a fetchable URL', async () => {
    const result = await putPublicAsset('avatars/u1/a.png', new Blob(['x']), 'image/png');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.bucket).toBe('motir-public');
    expect(withoutSuffix(seen[0]!.key)).toBe('avatars/u1/a.png');
    expect(seen[0]!.headers['content-type']).toBe('image/png');
    // The URL is the public base + the SUFFIXED key, so it addresses the object
    // that was actually written.
    expect(result.url).toBe(`${ENV.MOTIR_S3_PUBLIC_BASE_URL}/${seen[0]!.key}`);
  });

  it('putPrivateAttachment writes the PRIVATE bucket and returns the KEY, never a URL', async () => {
    const result = await putPrivateAttachment('attachments/w1/f.pdf', new Blob(['x']), 'x/pdf');

    expect(seen[0]!.bucket).toBe('motir-private');
    expect(result).not.toHaveProperty('url');
    expect(withoutSuffix(result.pathname)).toBe('attachments/w1/f.pdf');
    expect(result.pathname).toBe(seen[0]!.key);
  });

  it('putAttachment (the legacy public put) still targets the PUBLIC bucket', async () => {
    const result = await putAttachment('legacy/a.png', new Blob(['x']), 'image/png');
    expect(seen[0]!.bucket).toBe('motir-public');
    expect(result.url.startsWith(ENV.MOTIR_S3_PUBLIC_BASE_URL)).toBe(true);
  });

  it('deleteAttachmentBlob deletes from PRIVATE, deletePublicAsset from PUBLIC', async () => {
    await deleteAttachmentBlob('attachments/w1/f-aaaaaaaaaa.pdf');
    await deletePublicAsset(`${ENV.MOTIR_S3_PUBLIC_BASE_URL}/avatars/u1/a-bbbbbbbbbb.png`);

    expect(seen.map((s) => [s.method, s.bucket, s.key])).toEqual([
      ['DELETE', 'motir-private', 'attachments/w1/f-aaaaaaaaaa.pdf'],
      ['DELETE', 'motir-public', 'avatars/u1/a-bbbbbbbbbb.png'],
    ]);
  });

  it('deletePublicAsset resolves a PRE-MIGRATION Vercel URL to the same key', async () => {
    // The objects were copied across at the same key (MOTIR-2401), so a
    // `User.image` still carrying the old host is still garbage-collectable.
    await deletePublicAsset('https://store1.public.blob.vercel-storage.com/avatars/u1/old.png');
    expect(seen[0]).toMatchObject({
      method: 'DELETE',
      bucket: 'motir-public',
      key: 'avatars/u1/old.png',
    });
  });

  it('deletePublicAsset is a no-op for a URL that is not ours', async () => {
    await deletePublicAsset('https://lh3.googleusercontent.com/a/photo.jpg');
    expect(seen).toHaveLength(0);
  });

  it('two same-named uploads get DIFFERENT keys (the random suffix)', async () => {
    await putPrivateAttachment('attachments/w1/shot.png', new Blob(['a']), 'image/png');
    await putPrivateAttachment('attachments/w1/shot.png', new Blob(['b']), 'image/png');
    expect(seen[0]!.key).not.toBe(seen[1]!.key);
    // The suffix is an INFIX — the extension survives for content-type sniffing.
    for (const s of seen) expect(s.key.endsWith('.png')).toBe(true);
  });
});

describe('signedDownloadUrl — a presigned GET at the ADR’s 300 s', () => {
  it('signs a GET on the private bucket that expires in 300 s by default', async () => {
    const url = await signedDownloadUrl('attachments/w1/f-aaaaaaaaaa.pdf');
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/motir-private/attachments/w1/f-aaaaaaaaaa.pdf');
    // The expiry is read off the URL the caller is handed, not off our own input.
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    // Presigning is client-side: no request left the process.
    expect(seen).toHaveLength(0);
  });

  it('honours an explicit ttl', async () => {
    const url = await signedDownloadUrl('attachments/w1/f.pdf', { ttlSeconds: 60 });
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('binds the download disposition INTO the signature, not as a bare suffix', async () => {
    const url = await signedDownloadUrl('attachments/w1/archive-aaaaaaaaaa.zip', {
      download: true,
    });
    const parsed = new URL(url);

    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="archive-aaaaaaaaaa.zip"',
    );
    // S3 rejects an UNSIGNED response-header override, so the override has to be
    // covered by the signature — which it is only because it was part of the
    // signed command. (The old `?download=1` suffix could not have survived.)
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    const plain = await signedDownloadUrl('attachments/w1/archive-aaaaaaaaaa.zip');
    expect(new URL(plain).searchParams.get('X-Amz-Signature')).not.toBe(
      parsed.searchParams.get('X-Amz-Signature'),
    );
  });

  it('short-circuits to the mock host under E2E_TEST_BLOB', async () => {
    process.env['E2E_TEST_BLOB'] = '1';
    expect(await signedDownloadUrl('a/b.png')).toBe(
      'https://e2etest.public.blob.vercel-storage.com/a/b.png',
    );
  });
});

describe('mintPrivateUploadToken — a presigned PUT whose content type is BOUND', () => {
  it('binds contentType at SIGNING time — it is inside X-Amz-SignedHeaders', async () => {
    const url = await mintPrivateUploadToken('acceptance/w/s/v.webm', {
      contentType: 'video/webm',
      maxBytes: 100,
    });
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/motir-private/acceptance/w/s/v.webm');
    // THE assertion this seam exists for. A presigned PUT carries only what the
    // SIGNER bound; by default the presigner drops ContentType entirely, leaving
    // the uploader free to send anything. Naming it in the signed headers is what
    // makes the bound type enforceable — an uploader sending a different one is
    // rejected by the signature check.
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('a DIFFERENT content type produces a different signature — the binding is real', async () => {
    const asVideo = await mintPrivateUploadToken('acceptance/w/s/v.webm', {
      contentType: 'video/webm',
      maxBytes: 100,
      ttlSeconds: 300,
    });
    const asZip = await mintPrivateUploadToken('acceptance/w/s/v.webm', {
      contentType: 'application/zip',
      maxBytes: 100,
      ttlSeconds: 300,
    });
    // Same key, same expiry, same credentials — only the bound type differs. If
    // the type were NOT signed, these two would be identical, and the "binding"
    // would be decoration.
    expect(new URL(asVideo).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(asZip).searchParams.get('X-Amz-Signature'),
    );
  });

  it('defaults to a 300 s grant and honours an explicit ttl', async () => {
    const dflt = await mintPrivateUploadToken('a/b.webm', {
      contentType: 'video/webm',
      maxBytes: 1,
    });
    expect(new URL(dflt).searchParams.get('X-Amz-Expires')).toBe('300');
    const short = await mintPrivateUploadToken('a/b.webm', {
      contentType: 'video/webm',
      maxBytes: 1,
      ttlSeconds: 30,
    });
    expect(new URL(short).searchParams.get('X-Amz-Expires')).toBe('30');
  });
});

describe('headPrivateBlob — the authoritative metadata read', () => {
  it('returns the size + contentType the STORE reports', async () => {
    responses.set('HEAD motir-private/acceptance/v.webm', {
      statusCode: 200,
      headers: { 'content-length': '4096', 'content-type': 'video/webm' },
    });

    expect(await headPrivateBlob('acceptance/v.webm')).toEqual({
      size: 4096,
      contentType: 'video/webm',
    });
    expect(seen[0]).toMatchObject({ method: 'HEAD', bucket: 'motir-private' });
  });

  it('returns null for an object that is not there', async () => {
    responses.set('HEAD motir-private/acceptance/missing.webm', { statusCode: 404 });
    expect(await headPrivateBlob('acceptance/missing.webm')).toBeNull();
  });
});

describe('a PRE-MIGRATION object — written behind the module’s back — still downloads', () => {
  // The assertion that catches code pointed at an empty new bucket. Every other
  // test here creates what it reads, so all of them would pass against a store
  // that only ever contains what this module put there. This one writes with the
  // RAW client — bypassing `putPrivateAttachment`, its random suffix and its
  // content-type handling, exactly as an object copied from the old store would
  // arrive — and then demands that the module serve it.
  it('reads back an object the uploader never wrote', async () => {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const legacyKey = 'attachments/w1/legacy-no-suffix.pdf';

    await s3Client().send(
      new PutObjectCommand({
        Bucket: ENV.MOTIR_S3_PRIVATE_BUCKET,
        Key: legacyKey,
        Body: Buffer.from('legacy bytes'),
        ContentType: 'application/pdf',
      }),
    );
    expect(seen[0]).toMatchObject({ method: 'PUT', bucket: 'motir-private', key: legacyKey });

    responses.set(`HEAD motir-private/${legacyKey}`, {
      statusCode: 200,
      headers: { 'content-length': '12', 'content-type': 'application/pdf' },
    });
    expect(await headPrivateBlob(legacyKey)).toEqual({ size: 12, contentType: 'application/pdf' });

    // And the content route's presign addresses that exact key — no suffix is
    // invented, nothing assumes the key came from our own put path.
    const url = new URL(await signedDownloadUrl(legacyKey));
    expect(url.pathname).toBe(`/motir-private/${legacyKey}`);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});

describe('configuration', () => {
  it('an unset bucket fails LOUDLY rather than writing somewhere unexpected', async () => {
    delete process.env['MOTIR_S3_PRIVATE_BUCKET'];
    await expect(
      putPrivateAttachment('attachments/w1/f.pdf', new Blob(['x']), 'x/pdf'),
    ).rejects.toThrow(/MOTIR_S3_PRIVATE_BUCKET is not set/);
  });

  it('importing the module requires NO configuration (the build traces it unset)', async () => {
    for (const name of Object.keys(ENV)) delete process.env[name];
    await expect(import('@/lib/blob/uploader')).resolves.toBeTruthy();
  });
});
