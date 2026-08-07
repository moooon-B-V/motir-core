// One-shot object migration: the two Vercel Blob stores → the two S3 buckets
// (MOTIR-2389 ships this; MOTIR-2401 RUNS it; MOTIR-2393 deletes it afterwards).
//
// The code move and the data move are different kinds of work: this file is the
// tool, and running it needs a read credential for the store being left, a
// write credential for the buckets being adopted, and a person to accept the
// result. So the script is deliberately safe to run repeatedly and to run
// FIRST in a mode that changes nothing:
//
//   pnpm tsx scripts/migrate-blob-objects.ts             # inventory only (default)
//   pnpm tsx scripts/migrate-blob-objects.ts --apply     # copy
//   pnpm tsx scripts/migrate-blob-objects.ts --verify    # compare both sides
//
// Objects are copied at the SAME KEY, which is what lets a pre-migration
// `Attachment.blobPathname` keep resolving through the new seam untouched.
//
// Env: BLOB_READ_WRITE_TOKEN + BLOB_PUBLIC_READ_WRITE_TOKEN (the sources) and
// the seven MOTIR_S3_* variables (the destination — see .env.example).

/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import { get as getBlob, list as listBlobs } from '@vercel/blob';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { privateBucket, publicBucket, s3Client } from '@/lib/blob/s3';

/** The two stores, each with its own source token and destination bucket. */
export type StoreName = 'private' | 'public';
export const STORES: readonly StoreName[] = ['private', 'public'];

export interface SourceObject {
  pathname: string;
  size: number;
}

export interface DestObject {
  size: number;
}

/**
 * Everything that touches a network, in one injectable surface — so the copy
 * LOGIC below is testable against a faked source listing and a faked
 * destination, with no credentials and no buckets.
 */
export interface MigrationDeps {
  listSource(store: StoreName): Promise<SourceObject[]>;
  readSource(store: StoreName, pathname: string): Promise<{ body: Buffer; contentType: string }>;
  headDest(store: StoreName, key: string): Promise<DestObject | null>;
  putDest(store: StoreName, key: string, body: Buffer, contentType: string): Promise<void>;
}

export interface StoreReport {
  store: StoreName;
  /** The INVENTORY — what the source holds, whatever the mode. Zero is a reading. */
  objects: number;
  bytes: number;
  copied: string[];
  /** Already present at the same key AND size — the idempotent re-run case. */
  skipped: string[];
  failed: { pathname: string; error: string }[];
}

export interface VerifyReport {
  store: StoreName;
  checked: number;
  missing: string[];
  sizeMismatch: { pathname: string; source: number; dest: number }[];
}

/**
 * Copy one store. Idempotent by construction: an object already present at the
 * same key AND the same size is skipped, so a re-run after a partial failure
 * resumes rather than re-uploading. A size MISMATCH is not skipped — it is
 * re-copied, because a truncated destination object is exactly what a resumed
 * run exists to repair.
 */
export async function migrateStore(
  store: StoreName,
  deps: MigrationDeps,
  opts: { dryRun: boolean },
): Promise<StoreReport> {
  const sources = await deps.listSource(store);
  const report: StoreReport = {
    store,
    objects: sources.length,
    bytes: sources.reduce((sum, o) => sum + o.size, 0),
    copied: [],
    skipped: [],
    failed: [],
  };

  for (const source of sources) {
    try {
      const existing = await deps.headDest(store, source.pathname);
      if (existing && existing.size === source.size) {
        report.skipped.push(source.pathname);
        continue;
      }
      if (opts.dryRun) {
        report.copied.push(source.pathname);
        continue;
      }
      const { body, contentType } = await deps.readSource(store, source.pathname);
      await deps.putDest(store, source.pathname, body, contentType);
      report.copied.push(source.pathname);
    } catch (err) {
      report.failed.push({ pathname: source.pathname, error: String(err) });
    }
  }
  return report;
}

/**
 * Re-list the source and confirm every object is present in the destination at
 * the same key and size. This is the pass whose output goes onto MOTIR-2401 —
 * "the copy ran" is a claim about the writer; this is a claim about the result.
 */
export async function verifyStore(store: StoreName, deps: MigrationDeps): Promise<VerifyReport> {
  const sources = await deps.listSource(store);
  const report: VerifyReport = { store, checked: sources.length, missing: [], sizeMismatch: [] };
  for (const source of sources) {
    const dest = await deps.headDest(store, source.pathname);
    if (!dest) {
      report.missing.push(source.pathname);
    } else if (dest.size !== source.size) {
      report.sizeMismatch.push({ pathname: source.pathname, source: source.size, dest: dest.size });
    }
  }
  return report;
}

export async function runMigration(
  deps: MigrationDeps,
  opts: { dryRun: boolean },
): Promise<StoreReport[]> {
  const reports: StoreReport[] = [];
  for (const store of STORES) reports.push(await migrateStore(store, deps, opts));
  return reports;
}

export async function runVerify(deps: MigrationDeps): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = [];
  for (const store of STORES) reports.push(await verifyStore(store, deps));
  return reports;
}

// ── The real dependency surface ──────────────────────────────────────────────

function sourceToken(store: StoreName): string {
  const name = store === 'public' ? 'BLOB_PUBLIC_READ_WRITE_TOKEN' : 'BLOB_READ_WRITE_TOKEN';
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — the ${store} SOURCE store cannot be listed.`);
  return value;
}

function destBucket(store: StoreName): string {
  return store === 'public' ? publicBucket() : privateBucket();
}

export const liveDeps: MigrationDeps = {
  async listSource(store) {
    const objects: SourceObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await listBlobs({ token: sourceToken(store), cursor, limit: 1000 });
      for (const blob of page.blobs) {
        objects.push({ pathname: blob.pathname, size: blob.size });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return objects;
  },

  async readSource(store, pathname) {
    const result = await getBlob(pathname, {
      access: store === 'public' ? 'public' : 'private',
      token: sourceToken(store),
    });
    if (!result?.stream) throw new Error(`source object is gone: ${pathname}`);
    const chunks: Buffer[] = [];
    // `stream` is a web ReadableStream; async-iterate it into a Buffer. These
    // are attachments and acceptance videos — up to the per-file cap — so
    // buffering one at a time is fine and keeps the destination PUT sized.
    const reader = result.stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return {
      body: Buffer.concat(chunks),
      contentType: result.headers.get('content-type') ?? 'application/octet-stream',
    };
  },

  async headDest(store, key) {
    try {
      const result = await s3Client().send(
        new HeadObjectCommand({ Bucket: destBucket(store), Key: key }),
      );
      return { size: result.ContentLength ?? 0 };
    } catch {
      return null;
    }
  },

  async putDest(store, key, body, contentType) {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: destBucket(store),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  },
};

// ── CLI ──────────────────────────────────────────────────────────────────────

export function formatStoreReport(report: StoreReport, dryRun: boolean): string {
  const verb = dryRun ? 'would copy' : 'copied';
  const lines = [
    `${report.store} store: ${report.objects} objects, ${report.bytes} bytes`,
    `  ${verb}: ${report.copied.length}   already present: ${report.skipped.length}   failed: ${report.failed.length}`,
  ];
  for (const failure of report.failed) lines.push(`  ! ${failure.pathname}: ${failure.error}`);
  return lines.join('\n');
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines = [
    `${report.store} store: ${report.checked} checked, ${report.missing.length} missing, ${report.sizeMismatch.length} size-mismatched`,
  ];
  for (const key of report.missing) lines.push(`  MISSING  ${key}`);
  for (const m of report.sizeMismatch) {
    lines.push(`  SIZE     ${m.pathname} (source ${m.source} != dest ${m.dest})`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verify = args.includes('--verify');
  // DRY RUN IS THE DEFAULT. Copying is opt-in, so a mistyped invocation reads
  // rather than writes.
  const dryRun = !args.includes('--apply');

  if (verify) {
    const reports = await runVerify(liveDeps);
    for (const report of reports) console.log(formatVerifyReport(report));
    const clean = reports.every((r) => r.missing.length === 0 && r.sizeMismatch.length === 0);
    console.log(clean ? '\nVERIFY OK — no discrepancies.' : '\nVERIFY FAILED — see above.');
    process.exitCode = clean ? 0 : 1;
    return;
  }

  if (dryRun) console.log('DRY RUN — nothing is written. Re-run with --apply to copy.\n');
  const reports = await runMigration(liveDeps, { dryRun });
  for (const report of reports) console.log(formatStoreReport(report, dryRun));
  if (reports.some((r) => r.failed.length > 0)) process.exitCode = 1;
}

// Run only when invoked directly, so the pure functions above stay importable.
if (process.argv[1] && process.argv[1].endsWith('migrate-blob-objects.ts')) {
  void main();
}
