/**
 * `pnpm db:seed:collab` — the runner for the collaboration-shaped at-scale
 * fixture (Subtask 5.6.1). The actual seeding lives in
 * `scripts/seedCollabFixture.ts` (importable by the E2E helpers); this file
 * owns the PROCESS concerns:
 *
 * **The embedded external-seam stub.** The fixture seeds through the shipped
 * services, and two of those paths call out of process: the object-store
 * uploader (`lib/blob/uploader` — every attachment upload) and the Inngest
 * event API (`lib/jobs/sendEvent` — fired post-commit by every comment).
 * Neither external should run at seed time: there are no real store credentials
 * in dev/CI (CI's are placeholders), and 300+ comment events would either THROW
 * (no event key — `inngest.send` is not fire-and-forget) or enqueue hundreds
 * of pointless notification jobs against a live dev server. So the runner
 * starts ONE tiny local HTTP server speaking just enough of both APIs and
 * points both SDKs at it via env (`MOTIR_S3_*`, `INNGEST_DEV` +
 * `INNGEST_BASE_URL`) — every gate, transaction, audit row and link-on-write
 * still runs the real shipped code.
 *
 * ⚠️ The blob half is a REAL local HTTP server rather than an undici intercept,
 * and it must stay one (MOTIR-2389): this seed runs as its own PROCESS with no
 * instrumentation hook, and the S3 SDK transports over `node:https`, which an
 * undici dispatcher does not govern. Pointing `MOTIR_S3_ENDPOINT` at a socket
 * that really exists is what makes it interceptable at all.
 *
 * The env vars must be set BEFORE the SDK clients load, so the fixture module
 * is imported DYNAMICALLY after the stub is listening.
 */
/* eslint-disable no-console -- a CLI dev script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import http from 'node:http';

function startSeamStub(): Promise<{ origin: string; close: () => void }> {
  let uploadCounter = 0;
  const server = http.createServer((req, res) => {
    // Drain the body — the blob SDK streams the file bytes up.
    req.on('data', () => {});
    req.on('end', () => {
      if (req.url?.startsWith('/e/')) {
        // Inngest event API: ack and drop (seed-time events are noise).
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ids: [`evt_seed_${++uploadCounter}`], status: 200 }));
        return;
      }
      // The object store: an S3 PUT/HEAD/DELETE on `/<bucket>/<key>`. The
      // uploader computes the key itself, so an empty 200 with an ETag is the
      // whole contract a seed-time write needs.
      uploadCounter += 1;
      res.writeHead(req.method === 'DELETE' ? 204 : 200, { etag: `"seed-${uploadCounter}"` });
      res.end();
    });
  });
  return new Promise((resolve) => {
    // Port 0 — an ephemeral port, so parallel worktree sessions never collide.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('seam stub failed to bind');
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => server.close(),
      });
    });
  });
}

async function main() {
  const stub = await startSeamStub();
  // Both SDK overrides BEFORE the fixture (and thus the SDK clients) load.
  // The object store points at the stub socket; the credentials only have to
  // exist for the signer, since the stub never checks a signature.
  process.env['MOTIR_S3_ENDPOINT'] = stub.origin;
  process.env['MOTIR_S3_REGION'] ??= 'auto';
  process.env['MOTIR_S3_ACCESS_KEY_ID'] ??= 'seed-collab-local-stub';
  process.env['MOTIR_S3_SECRET_ACCESS_KEY'] ??= 'seed-collab-local-stub-secret';
  process.env['MOTIR_S3_PRIVATE_BUCKET'] ??= 'seed-collab-private';
  process.env['MOTIR_S3_PUBLIC_BUCKET'] ??= 'seed-collab-public';
  // Kept on the legacy public host shape so any fixture expectation about an
  // avatar URL still holds; the bytes never leave this process either way.
  process.env['MOTIR_S3_PUBLIC_BASE_URL'] ??= 'https://seed-collab.public.blob.vercel-storage.com';
  process.env['INNGEST_DEV'] = '1';
  process.env['INNGEST_BASE_URL'] = stub.origin;

  const { seedCollabFixture, SEED_COLLAB_OWNER_EMAIL, SEED_COLLAB_PASSWORD } =
    await import('./seedCollabFixture');
  try {
    const m = await seedCollabFixture();
    console.log('\n✅ Seeded the collaboration-loaded issue.');
    console.log('────────────────────────────────────────────────────────');
    console.log(`  Sign in:     ${SEED_COLLAB_OWNER_EMAIL} / ${SEED_COLLAB_PASSWORD}`);
    console.log(`  Issue:       ${m.loadedIssueIdentifier} (${m.loadedIssueId})`);
    console.log(`  Comments:    ${m.comments} (${m.replies} replies, ${m.mentionRows} mentions)`);
    console.log(
      `  Attachments: ${m.panelAttachments + m.editorAttachments} ` +
        `(${m.panelAttachments} panel + ${m.editorAttachments} editor)`,
    );
    console.log(
      `  Rail:        ${m.customFieldsValued} field values · ${m.labels} labels · ` +
        `${m.components} components · ${m.watchers} watchers`,
    );
    console.log(`  Revisions:   ${m.revisions}`);
    console.log(`  Spread:      ${m.spreadIssues} normally-loaded siblings`);
    console.log('  Then open the issue detail — every Epic-5 surface populated at once.');
    console.log('────────────────────────────────────────────────────────');
  } finally {
    stub.close();
  }
}

main()
  .then(async () => {
    const { db } = await import('@/lib/db');
    await db.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    const { db } = await import('@/lib/db');
    await db.$disconnect();
    process.exitCode = 1;
  });
