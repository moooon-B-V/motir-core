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

import { S3Client } from '@aws-sdk/client-s3';

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
 * The shared S3 client, built on first use and re-built if the configuration
 * changes (which only happens in tests — the cache key is the credential tuple,
 * so a suite that re-points the env gets a client for the NEW endpoint rather
 * than a stale one).
 *
 * `forcePathStyle` is deliberate: it keeps every request on ONE host (the
 * endpoint), instead of `https://<bucket>.<endpoint>`. Tigris serves both, and
 * a single stable host is what makes the E2E's undici interception (and any
 * self-hosted MinIO) work without per-bucket wiring.
 */
export function s3Client(): S3Client {
  const endpoint = required(S3_ENV.endpoint);
  const accessKeyId = required(S3_ENV.accessKeyId);
  const secretAccessKey = required(S3_ENV.secretAccessKey);
  // Tigris is region-less; `auto` is the conventional value and the SDK
  // requires SOMETHING to sign with, so it is defaulted rather than required.
  const region = process.env[S3_ENV.region] || 'auto';
  const key = `${endpoint}|${region}|${accessKeyId}|${secretAccessKey}`;

  if (cached && cached.key === key) return cached.client;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  cached = { client, key };
  return client;
}

/** Test seam: drop the memoized client so the next call re-reads the env. */
export function resetS3ClientForTests(): void {
  cached = null;
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
