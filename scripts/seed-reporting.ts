/**
 * `pnpm db:seed:reporting` — the runner for the reporting-shaped at-scale
 * fixture (Subtask 6.7.1). The actual seeding lives in
 * `scripts/seedReportingFixture.ts` (importable by the E2E helpers); this file
 * owns the PROCESS concerns:
 *
 * **The embedded Inngest stub.** The fixture seeds through the shipped services,
 * and the work-item write paths fire post-commit job events via
 * `lib/jobs/sendEvent` (`work-item/created`, `work-item/transitioned`, …). At
 * seed time there is no event key in dev/CI and no point enqueueing tens of
 * thousands of pointless notification/automation jobs, so the runner starts ONE
 * tiny local HTTP server that acks-and-drops the Inngest event API and points the
 * SDK at it via its documented env overrides (`INNGEST_DEV` + `INNGEST_BASE_URL`)
 * — exactly the seam the test suite mocks (the Playwright harness's Inngest dev
 * server). Every gate, transaction and audit row still runs the real shipped code.
 * (This is the same runner shape as `scripts/seed-collab.ts`.)
 *
 * The env vars must be set BEFORE `lib/jobs/client` loads, so the fixture module
 * is imported DYNAMICALLY after the stub is listening.
 */
/* eslint-disable no-console -- a CLI dev script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import http from 'node:http';

function startInngestStub(): Promise<{ origin: string; close: () => void }> {
  let counter = 0;
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      // Inngest event API: ack and drop (seed-time events are noise).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ids: [`evt_seed_${++counter}`], status: 200 }));
    });
  });
  return new Promise((resolve) => {
    // Port 0 — an ephemeral port, so parallel worktree sessions never collide.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('inngest stub failed to bind');
      }
      resolve({ origin: `http://127.0.0.1:${address.port}`, close: () => server.close() });
    });
  });
}

async function main() {
  const stub = await startInngestStub();
  // The SDK overrides BEFORE the fixture (and thus the jobs client) loads.
  process.env['INNGEST_DEV'] = '1';
  process.env['INNGEST_BASE_URL'] = stub.origin;

  const {
    seedReportingFixture,
    SEED_REPORTING_OWNER_EMAIL,
    SEED_REPORTING_PASSWORD,
    SEED_REPORTING_DASHBOARD_NAME,
  } = await import('./seedReportingFixture');
  try {
    const m = await seedReportingFixture();
    const statusLine = Object.entries(m.statusCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ');
    console.log('\n✅ Seeded the reporting-shaped corpus.');
    console.log('────────────────────────────────────────────────────────');
    console.log(`  Sign in:    ${SEED_REPORTING_OWNER_EMAIL} / ${SEED_REPORTING_PASSWORD}`);
    console.log(
      `  Project:    ${m.projectIdentifier} (${m.items} items, ${m.resolvedItems} resolved)`,
    );
    console.log(`  Window:     ${m.windowStart.slice(0, 10)} → ${m.windowEnd.slice(0, 10)}`);
    console.log(`  Statuses:   ${statusLine}`);
    console.log(
      `  Rich:       ${m.richItems} items · ${m.customFieldValues} CF values · ` +
        `${m.labelLinks} label links · ${m.componentLinks} component links`,
    );
    console.log(
      `  Epic-6:     ${m.savedFilters} saved filters · "${SEED_REPORTING_DASHBOARD_NAME}" ` +
        `(${m.dashboardWidgets} widgets) · ${m.rules} enabled rules`,
    );
    console.log('  Then open Reports / Dashboards over the corpus.');
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
