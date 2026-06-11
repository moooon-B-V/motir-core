/**
 * `pnpm db:seed:collab` — the runner for the collaboration-shaped at-scale
 * fixture (Subtask 5.6.1). The actual seeding lives in
 * `scripts/seedCollabFixture.ts` (importable by the E2E helpers); this file
 * owns the PROCESS concerns:
 *
 * **The embedded external-seam stub.** The fixture seeds through the shipped
 * services, and two of those paths call out of process: the Vercel-Blob
 * uploader (`lib/blob/uploader` — every attachment upload) and the Inngest
 * event API (`lib/jobs/sendEvent` — fired post-commit by every comment).
 * Neither external should run at seed time: there is no real blob token in
 * dev/CI (CI's is a placeholder), and 300+ comment events would either THROW
 * (no event key — `inngest.send` is not fire-and-forget) or enqueue hundreds
 * of pointless notification jobs against a live dev server. So the runner
 * starts ONE tiny local HTTP server speaking just enough of both APIs and
 * points both SDKs at it via their own documented env overrides
 * (`VERCEL_BLOB_API_URL`, `INNGEST_DEV` + `INNGEST_BASE_URL`). These are
 * exactly the two seams the test suite mocks (`vi.mock('@/lib/blob/uploader')`
 * in 5.2.8; the Playwright harness's Inngest dev server) — every gate,
 * transaction, audit row and link-on-write still runs the real shipped code.
 *
 * The env vars must be set BEFORE `lib/jobs/client` / `@vercel/blob` load, so
 * the fixture module is imported DYNAMICALLY after the stub is listening.
 *
 * Blob URLs the stub mints are deterministic in ORDER (an incrementing
 * counter stands in for the real API's random suffix) and carry the
 * `.public.blob.vercel-storage.com` host + `/attachments/<workspaceId>/`
 * pathname the 5.2.3 link-on-write parser requires.
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
      // Vercel Blob put API: the SDK passes the target as ?pathname=…
      const query = new URL(req.url ?? '/', 'http://stub').searchParams;
      const pathname = query.get('pathname') ?? `attachments/unknown/${++uploadCounter}`;
      const url = `https://seed-collab.public.blob.vercel-storage.com/${pathname}-s${++uploadCounter}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          url,
          downloadUrl: `${url}?download=1`,
          pathname,
          contentType: 'application/octet-stream',
          contentDisposition: 'attachment',
        }),
      );
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
  process.env['VERCEL_BLOB_API_URL'] = stub.origin;
  process.env['BLOB_READ_WRITE_TOKEN'] ??= 'vercel_blob_rw_seed_collab_local_stub';
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
