/**
 * `pnpm db:seed:reporting` — the runner for the reporting-shaped at-scale
 * fixture (Subtask 6.7.1). The actual seeding lives in
 * `scripts/seedReportingFixture.ts` (importable by the E2E helpers); this file
 * owns the PROCESS concerns:
 *
 * ⚠️ IT USED TO OWN AN EMBEDDED EVENT-API STUB, AND NO LONGER NEEDS ONE
 * (MOTIR-3418). The fixture seeds through the shipped services, and the work-item
 * write paths fire post-commit job events via `lib/jobs/sendEvent`
 * (`work-item/created`, `work-item/transitioned`, …). While an emit was an HTTP
 * send to a third party, seed time had no event key in dev/CI and no appetite for
 * tens of thousands of pointless notification jobs, so this runner started a tiny
 * local server that acked and dropped them and pointed the SDK at it. An emit is
 * a row in the database this seed is already writing to now: nothing leaves the
 * process, so there is nothing to stub. The rows are enqueued and sit there
 * unless a worker is running.
 *
 * What remains here is the ordinary runner shape — load the env, drive the
 * fixture, print what a developer needs to sign in with. (Same shape as
 * `scripts/seed-collab.ts`, which still stubs its OWN remaining seam, the object
 * store.)
 */
/* eslint-disable no-console -- a CLI dev script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads

async function main() {
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
  } catch (err) {
    console.error('❌ seed:reporting failed', err);
    throw err;
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
