// The S3-compatible object-store client (MOTIR-2389) — the ONE place the
// provider's SDK is configured, so `lib/blob/uploader.ts` stays a set of
// object operations and this file owns endpoint/credential/bucket policy.
//
// Provider: Tigris (Fly's S3-compatible store), per
// `docs/decisions/application-hosting.md` Q2. Nothing here is Tigris-specific
// beyond the endpoint value — the API is S3, which is also what a self-hoster
// is most likely to have (`attachment-access-control.md` Amendment 2).
//
// TWO BUCKETS, not one bucket with per-object ACLs: a PUBLIC bucket for
// avatars/public assets (directly fetchable, CDN-cacheable) and a PRIVATE one
// for content (presigned GET only, through the authenticated content route).
// The split is structural so it cannot be got wrong one object at a time.
//
// ⚠️ Every env read below is LAZY — inside the accessor, never at module
// scope. Importing this module must not require configuration: several suites
// `importOriginal` the uploader to stub one function while keeping the rest,
// and `next build` traces the module without any secret present.

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/** Env var names, in one place — `MOTIR-2386` sets exactly these as Fly secrets. */
export const S3_ENV = {
  endpoint: 'MOTIR_S3_ENDPOINT',
  region: 'MOTIR_S3_REGION',
  accessKeyId: 'MOTIR_S3_ACCESS_KEY_ID',
  secretAccessKey: 'MOTIR_S3_SECRET_ACCESS_KEY',
  privateBucket: 'MOTIR_S3_PRIVATE_BUCKET',
  publicBucket: 'MOTIR_S3_PUBLIC_BUCKET',
  publicBaseUrl: 'MOTIR_S3_PUBLIC_BASE_URL',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — the blob store is unconfigured. See .env.example (MOTIR-2389).`,
    );
  }
  return value;
}

let cached: { client: S3Client; key: string } | null = null;

/**
 * An E2E-only transport, installed at boot by `instrumentation.ts`.
 *
 * ⚠️ TWO things about this are load-bearing, and both were learned the hard way.
 *
 * **It is installed at the SDK's transport, not at undici.** Every other E2E
 * seam intercepts an undici `MockAgent`, which cannot reach this one: undici's
 * global dispatcher governs `fetch`, and the AWS SDK's default Node transport is
 * `node:https`. `@vercel/blob` used `fetch`, so intercepting it worked; the swap
 * silently moved the traffic to a layer the interceptor does not see, and the
 * suite's uploads left as real DNS lookups.
 *
 * **It is held on `globalThis`, not in a module variable.** Next.js loads
 * `instrumentation.ts` in a DIFFERENT module graph from the route handlers, so
 * a module-level `let` set at instrumentation is simply not the same binding the
 * routes read — the boot log says "installed" and the routes still hit the
 * network. A `Symbol.for` key is process-global and crosses that boundary, which
 * is the same reason the other seams reach for `setGlobalDispatcher`.
 *
 * Typed loosely and set by injection, so this production module never imports
 * the test one; unset in every real deployment.
 */
const TRANSPORT_KEY = Symbol.for('motir.blob.e2eObjectStoreTransport');

type TransportHolder = { [TRANSPORT_KEY]?: unknown };

function e2eTransport(): unknown {
  return (globalThis as TransportHolder)[TRANSPORT_KEY] ?? null;
}

/**
 * Install an in-process transport for the object store (E2E only). Called from
 * `instrumentation.ts` behind `E2E_TEST_BLOB=1`, before any handler runs.
 */
export function installObjectStoreTransport(handler: unknown): void {
  (globalThis as TransportHolder)[TRANSPORT_KEY] = handler;
  cached = null;
}

/**
 * The shared S3 client, built on first use and re-built if the configuration
 * changes (which only happens in tests — the cache key is the credential tuple,
 * so a suite that re-points the env gets a client for the NEW endpoint rather
 * than a stale one).
 *
 * `forcePathStyle` is deliberate: it keeps every request on ONE host (the
 * endpoint) with the bucket in the PATH, instead of `https://<bucket>.<endpoint>`.
 * Tigris serves both, and one stable host with a readable bucket segment is what
 * lets the E2E transport (and a self-hosted MinIO) work without per-bucket wiring.
 */
export function s3Client(): S3Client {
  const endpoint = required(S3_ENV.endpoint);
  const accessKeyId = required(S3_ENV.accessKeyId);
  const secretAccessKey = required(S3_ENV.secretAccessKey);
  // Tigris is region-less; `auto` is the conventional value and the SDK
  // requires SOMETHING to sign with, so it is defaulted rather than required.
  const region = process.env[S3_ENV.region] || 'auto';
  const transport = e2eTransport();
  const key = `${endpoint}|${region}|${accessKeyId}|${secretAccessKey}|${transport ? 'e2e' : 'net'}`;

  if (cached && cached.key === key) return cached.client;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    ...(transport ? { requestHandler: transport as S3ClientConfig['requestHandler'] } : {}),
  });
  cached = { client, key };
  return client;
}

/** Test seam: drop the memoized client AND any installed transport, so the next
 *  call re-reads the env and goes back to the real one. */
export function resetS3ClientForTests(): void {
  cached = null;
  delete (globalThis as TransportHolder)[TRANSPORT_KEY];
}

/** The PRIVATE bucket — content attachments, acceptance video + trace. */
export function privateBucket(): string {
  return required(S3_ENV.privateBucket);
}

/** The PUBLIC bucket — avatars and other public assets. */
export function publicBucket(): string {
  return required(S3_ENV.publicBucket);
}

/**
 * The public bucket's directly-fetchable origin, with any trailing slash
 * trimmed — the prefix every public asset URL is built from, and the prefix
 * `isOwnAvatarBlobUrl` recognises one by.
 */
export function publicBaseUrl(): string {
  return required(S3_ENV.publicBaseUrl).replace(/\/+$/, '');
}

// A public asset's URL → its object KEY (the avatar GC needs a key, but
// `User.image` stores a full URL) lives in `lib/blob/referencedUrls.ts` as
// `publicAssetKeyFromUrl` — beside the avatar GATE that must agree with it,
// and dependency-free so it stays bundle-safe.
