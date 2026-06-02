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
import { resetDatabase, db } from './_helpers/db-reset';
import { truncateJobRuns } from '@/tests/helpers/db';
import { signUp } from './_helpers/shell-session';

const USER_EMAIL = 'e2e-jobs@example.com';

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobRuns();
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

async function gotoJobs(page: Page, query = ''): Promise<void> {
  await page.goto(`/settings/workspace/jobs${query}`);
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
}

test('@smoke jobs dashboard: empty states + sidebar link', async ({ page }) => {
  await signUp(page, USER_EMAIL);

  // The Settings section grows a "Job runs" sub-link that routes here.
  await page.goto('/dashboard');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Job runs' })
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
  const foreign = await db.workspace.create({
    data: { name: 'Foreign WS', slug: 'foreign-ws-e2e' },
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
  await expect(page.getByLabel('1 in dead-letter queue')).toBeVisible();

  // Open the DLQ tab and replay (the signed-up user is the workspace owner).
  await page.getByRole('link', { name: /Dead letter/ }).click();
  const replay = page.getByRole('button', { name: 'Replay' });
  await expect(replay).toBeEnabled();
  await replay.click();

  // Success toast + the row's "Replayed" cell now carries a timestamp (not —).
  await expect(page.getByText('Job replayed')).toBeVisible();
  await expect
    .poll(async () => {
      const row = await db.jobRunDlq.findFirst({ where: { workspaceId } });
      return row?.replayedAt ?? null;
    })
    .not.toBeNull();
});
