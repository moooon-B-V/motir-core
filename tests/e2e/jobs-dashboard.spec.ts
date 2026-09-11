// E2E: the operator dashboard (Story 1.6 · Subtask 1.6.5).
//
// @smoke — proves the workspace-scoped job-runs surface end to end through the
// real shell: empty states, the status filter, the DLQ-tab badge, and the
// owner-gated Replay action (re-emits via the Inngest dev server the Playwright
// config boots, then stamps the row's "Replayed" timestamp).
//
// Job rows are seeded DIRECTLY in the DB (db.jobRun / db.jobRunDlq) rather than
// driven through a failing job: the dashboard is a READ surface, so seeding the
// ledger is the honest, fast fixture. Rows are tied to the signed-in user's
// auto-created workspace so the workspace-scoped reads surface them; a control
// row under a second workspace proves the scope holds (RLS + the explicit
// workspace filter).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db, truncateJobTables } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

const USER_EMAIL = 'e2e-jobs@example.com';

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The signed-up user's auto-created workspace is "{local-part}'s Workspace".
async function workspaceIdFor(email: string): Promise<string> {
  const local = email.split('@')[0]!;
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(ws, 'auto-created workspace should exist').not.toBeNull();
  return ws!.id;
}

async function seedFailedRun(workspaceId: string): Promise<void> {
  await db.jobRun.create({
    data: {
      workspaceId,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: 'e2e-evt-failed',
      lane: 'engine',
      attempt: 0,
      status: 'failed',
      finishedAt: new Date(),
      durationMs: 12,
      failure: { message: 'deliberate e2e failure' },
    },
  });
}

async function seedDlqRow(workspaceId: string): Promise<void> {
  await db.jobRunDlq.create({
    data: {
      workspaceId,
      functionId: 'email.send',
      eventName: 'email.send',
      eventData: {
        to: 'e2e-replay@example.com',
        template: 'password-reset',
        data: { recipientName: 'E2E', resetUrl: 'http://localhost:3000/reset/e2e' },
        workspaceId,
        idempotencyKey: 'e2e-dlq-key',
      },
      failure: { message: 'deliberate e2e failure' },
      attempts: 1,
    },
  });
}

// ⚠️ THE DOOR MOVED FOR THIS FIXTURE (Story MOTIR-4843 · MOTIR-4861).
//
// These tests sign up a fresh user, who gets ONE auto-created workspace — the
// COLLAPSED state. `/settings/workspace/jobs` `notFound()`s there now, exactly
// as its three sibling workspace routes have since MOTIR-3502, and the dashboard
// is hosted as a section on `/settings/organization` instead
// (`JobRunsFoldInSection`). Same component, same reads, same tabs and filters —
// `basePath` is what differs, so every link inside comes back here.
//
// The alternative was to give the fixture a SECOND workspace and keep the old
// address. Rejected: this suite's whole subject is the dashboard, and the
// collapsed state is where most tenants will meet it. A fixture that reveals the
// tier just to reach the older URL would stop testing the arm that matters.
const JOBS_HOME = '/settings/organization';

async function gotoJobs(page: Page, query = ''): Promise<void> {
  await page.goto(`${JOBS_HOME}${query}`);
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
}

test('@smoke jobs dashboard: empty states + sidebar link', async ({ page }) => {
  await signUp(page, USER_EMAIL);

  // ⚠️ REACHED THROUGH THE PRODUCT, at the address this fixture's tenant has
  // (MOTIR-4847). This clicked a `Job runs` row in the rail's bottom section
  // until that row left it: the capability is workspace-tier, the rail is the
  // PROJECT's, and the tenancy mismatch is what the story removed. At one
  // workspace the door is the settings home, where the dashboard is folded in;
  // above the reveal it is a row in the workspace area's own rail
  // (`tests/components/SidebarNav-workspace-area.test.tsx`).
  //
  // Still a navigation rather than a `goto`, because what this case is FOR is
  // that the surface is reachable without knowing a URL.
  await page.goto('/dashboard');
  // ⚠️ THROUGH THE ORG MENU, NOT THE RAIL'S `Settings` ROW (MOTIR-4876). That
  // row reached this surface only because it was RE-POINTED at the settings
  // home for a reader with no active project — §6d's collapse below the
  // workspace-tier reveal, which `org-admin.spec.ts` describes from the other
  // side ("the href now matches TWO elements and strict mode refuses"). Every
  // member is inside a project now (MOTIR-4870), so the rail's row deep-links to
  // PROJECT settings and the two hrefs are no longer the same address.
  //
  // The org control is the door that survives at every workspace count, and it
  // keeps what this case is FOR: the surface is reachable without knowing a URL.
  // Scoped to the menu's own list rather than by href, for the reason that spec
  // gives — the scope is what the assertion always meant.
  await page.getByRole('button', { name: 'Organization menu' }).click();
  await page
    .getByRole('list')
    .filter({ has: page.locator('a[href="/settings/organization/members"]') })
    .locator('a[href="/settings/organization"]')
    .click();
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();

  // Fresh workspace → empty "Recent runs".
  await expect(page.getByText('No job runs yet')).toBeVisible();

  // Empty "Dead letter".
  await page.getByRole('link', { name: /Dead letter/ }).click();
  await expect(page.getByText('Nothing in the dead-letter queue')).toBeVisible();
});

test('@smoke jobs dashboard: a failed run shows under the Failed filter', async ({ page }) => {
  await signUp(page, USER_EMAIL);
  const workspaceId = await workspaceIdFor(USER_EMAIL);
  await seedFailedRun(workspaceId);

  await gotoJobs(page);
  // Default "Recent runs" shows the failed run.
  await expect(page.getByText('email.send').first()).toBeVisible();

  // Filter to Failed → still there.
  await page.getByRole('link', { name: 'Failed' }).click();
  await expect(page.getByText('email.send').first()).toBeVisible();

  // Filter to Succeeded → the failed run is gone (empty state).
  await page.getByRole('link', { name: 'Succeeded' }).click();
  await expect(page.getByText('No job runs yet')).toBeVisible();
});

test('@smoke jobs dashboard: a run in another workspace is NOT visible', async ({ page }) => {
  await signUp(page, USER_EMAIL);

  // Seed a run under a DIFFERENT workspace the user is not a member of.
  // Story 6.10: a workspace is nested under an Organization (organizationId is
  // non-nullable), so mint a parent org for this foreign-tenant fixture first.
  const foreignOrg = await db.organization.create({
    data: { name: 'Foreign WS', slug: 'foreign-ws-e2e-org' },
  });
  const foreign = await db.workspace.create({
    data: { name: 'Foreign WS', slug: 'foreign-ws-e2e', organizationId: foreignOrg.id },
  });
  await seedFailedRun(foreign.id);

  await gotoJobs(page);
  // The user's own workspace has no runs, so the foreign run must not leak.
  await expect(page.getByText('No job runs yet')).toBeVisible();
});

test('@smoke jobs dashboard: DLQ badge counts entries, and an owner replays', async ({ page }) => {
  await signUp(page, USER_EMAIL);
  const workspaceId = await workspaceIdFor(USER_EMAIL);
  await seedDlqRow(workspaceId);

  await gotoJobs(page);

  // The Dead-letter tab badge reflects the one un-replayed entry.
  await expect(page.getByRole('main').getByLabel('1 in dead-letter queue')).toBeVisible();

  // Open the DLQ tab and replay (the signed-up user is the workspace owner).
  await page.getByRole('link', { name: /Dead letter/ }).click();
  const replay = page.getByRole('button', { name: 'Replay' });
  await expect(replay).toBeEnabled();
  await replay.click();

  // Success toast + the row's "Replayed" cell now carries a timestamp (not —).
  // exact:true so the toast title isn't also matched by the sr-only live-region
  // announcement span ("Notification Job replayed…").
  await expect(page.getByText('Job replayed', { exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const row = await db.jobRunDlq.findFirst({ where: { workspaceId } });
      return row?.replayedAt ?? null;
    })
    .not.toBeNull();
});
