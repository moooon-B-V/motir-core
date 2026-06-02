// E2E: the Story-1.6 jobs flow, end to end through the REAL runtime (Subtask
// 1.6.6 — closes the Story).
//
// @smoke — proves the background-jobs stack (the defineJob runtime, the retry +
// dead-letter + replay patterns, and the 1.6.5 operator dashboard) holds
// together against a forced failure, driven through the running Next server +
// the Inngest dev server + Postgres the Playwright config boots.
//
// Unlike jobs-dashboard.spec.ts (which seeds ledger rows directly to test the
// READ surface fast), the happy-path and forced-failure scenarios here drive a
// REAL job: an invite enqueues `email.send`, the Inngest dev server invokes it,
// and we assert what actually landed in the ledger. That real path is the whole
// point — it's what caught PRODECT_FINDINGS #39 (the 1.6.4 dead-letter write
// never ran on the real executor; only the in-process unit harness made it look
// like it did) and #40 (replay re-emitting the unchanged idempotency key was
// dedup-dropped). The replay + role-gating scenarios seed a DLQ row directly
// (the honest fixture for an action surface — same call as jobs-dashboard.spec)
// and then exercise the real re-emit → job → outbox path.
//
// TIMING. The forced-failure path runs the full transient retry budget (3
// attempts with Inngest's real backoff ≈ 0s / 30s / 72s) before `onFailure`
// dead-letters, so that scenario needs ~90s+. Its test sets a generous timeout;
// the others are fast.

import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { truncateJobRuns } from '@/tests/helpers/db';
import { waitForEmail } from './_helpers/email-capture';
import { armEmailFault, clearEmailFault } from './_helpers/email-fault';

const PASSWORD = 'jobs-flow-spec-pass-123';

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobRuns();
  await clearEmailFault();
});

test.afterEach(async () => {
  // Never let an armed fault leak into the next spec sharing the dev server.
  await clearEmailFault();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

// Sign up a fresh user via the two-step credentials flow → lands on /dashboard
// with the auto-created "{local}'s Workspace" active (the signer is its owner,
// per the Story-1.2 role-reconciliation finding #36). Single deterministic
// submit — the E2E dev server runs with E2E_DISABLE_RATE_LIMIT=1, so there's no
// 429 to retry around (see shell-session.ts for the rationale).
async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
}

// The signed-up user's auto-created workspace is "{local-part}'s Workspace".
async function workspaceIdFor(email: string): Promise<string> {
  const local = email.split('@')[0]!;
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(ws, `auto-created workspace for ${email} should exist`).not.toBeNull();
  return ws!.id;
}

// Send an invite to `inviteeEmail` from the active workspace's settings page.
async function sendInvite(page: Page, inviteeEmail: string): Promise<void> {
  await page.goto('/settings/workspace');
  await page.getByRole('button', { name: 'Invite' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(inviteeEmail);
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(`Invite sent to ${inviteeEmail}`).first()).toBeVisible();
}

async function gotoJobs(page: Page): Promise<void> {
  await page.goto('/settings/workspace/jobs');
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
}

// Seed a dead-letter row directly (the honest fixture for the replay/role-gating
// action surfaces). The eventData is a valid workspace-invite `email.send`
// payload, so a replay re-emits a deliverable event.
async function seedInviteDlqRow(args: {
  workspaceId: string;
  to: string;
  idempotencyKey: string;
}): Promise<string> {
  const row = await db.jobRunDlq.create({
    data: {
      workspaceId: args.workspaceId,
      functionId: 'email.send',
      eventName: 'email.send',
      eventData: {
        workspaceId: args.workspaceId,
        idempotencyKey: args.idempotencyKey,
        to: args.to,
        template: 'workspace-invite',
        data: {
          inviterName: 'E2E Owner',
          workspaceName: 'E2E Workspace',
          acceptUrl: 'http://localhost:3000/invite/accept?token=' + args.idempotencyKey,
        },
      },
      failure: { message: 'seeded e2e failure' },
      attempts: 3,
    },
  });
  return row.id;
}

// ── scenarios ──────────────────────────────────────────────────────────────

test('@smoke happy path: an invite enqueues email.send, which succeeds and shows in Recent runs', async ({
  page,
}) => {
  const owner = 'jf-happy-owner@example.com';
  const invitee = 'jf-happy-invitee@example.com';
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);

  await sendInvite(page, invitee);

  // The invite email actually lands in the outbox (the job ran the provider).
  const email = await waitForEmail(invitee);
  expect(email.subject).toContain('invited to join');

  // The ledger has exactly one succeeded email.send run for this workspace.
  await expect
    .poll(async () =>
      db.jobRun.count({ where: { workspaceId, functionId: 'email.send', status: 'succeeded' } }),
    )
    .toBe(1);
  expect(await db.jobRun.count({ where: { workspaceId, status: 'failed' } })).toBe(0);

  // …and the dashboard renders it (server component → reload to re-fetch).
  await gotoJobs(page);
  await expect(page.getByText('email.send').first()).toBeVisible();
  await page.getByRole('link', { name: 'Succeeded' }).click();
  await expect(page.getByText('email.send').first()).toBeVisible();
});

test('@smoke forced failure: a failing send retries to exhaustion, then dead-letters', async ({
  page,
}) => {
  // Full transient retry budget runs on the real backoff before onFailure fires.
  test.setTimeout(180_000);

  const owner = 'jf-fail-owner@example.com';
  // The recipient contains the armed substring, so its send throws every attempt.
  const invitee = 'jf-fail-forcefail@example.com';
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);

  await armEmailFault('forcefail');
  await sendInvite(page, invitee);

  // After 3 attempts exhaust, onFailure writes the failed run + the DLQ row.
  await expect
    .poll(
      async () => ({
        failed: await db.jobRun.count({ where: { workspaceId, status: 'failed' } }),
        dlq: await db.jobRunDlq.count({ where: { workspaceId } }),
      }),
      { timeout: 150_000, intervals: [2_500] },
    )
    .toEqual({ failed: 1, dlq: 1 });

  // The dead-letter row recorded the full 3 attempts (the retry budget + 1).
  const dlqRow = await db.jobRunDlq.findFirst({ where: { workspaceId } });
  expect(dlqRow!.attempts).toBe(3);
  expect(dlqRow!.replayedAt).toBeNull();

  // The dashboard shows the failed run under the Failed filter…
  await gotoJobs(page);
  await page.getByRole('link', { name: 'Failed' }).click();
  await expect(page.getByText('email.send').first()).toBeVisible();

  // …and the Dead-letter tab badge counts the one un-replayed entry, attempts = 3.
  await expect(page.getByLabel('1 in dead-letter queue')).toBeVisible();
  await page.getByRole('link', { name: /Dead letter/ }).click();
  await expect(page.getByRole('cell', { name: '3', exact: true })).toBeVisible();
});

test('@smoke replay: an owner replays a dead-lettered send, which re-runs and succeeds', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const owner = 'jf-replay-owner@example.com';
  const replayTo = 'jf-replay-delivered@example.com';
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);
  // Seed a dead-lettered invite send (no fault armed → its replay will deliver).
  await seedInviteDlqRow({ workspaceId, to: replayTo, idempotencyKey: 'replay-token-1' });

  await gotoJobs(page);
  await page.getByRole('link', { name: /Dead letter/ }).click();
  const replay = page.getByRole('button', { name: 'Replay' });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect(page.getByText('Job replayed', { exact: true })).toBeVisible();

  // The re-emitted event (with a re-shaped idempotency key, finding #40) actually
  // runs: a fresh succeeded run appears AND the email is delivered.
  await expect
    .poll(
      async () =>
        db.jobRun.count({ where: { workspaceId, functionId: 'email.send', status: 'succeeded' } }),
      { timeout: 30_000, intervals: [1_500] },
    )
    .toBe(1);
  const delivered = await waitForEmail(replayTo);
  expect(delivered.subject).toContain('invited to join');

  // The DLQ row is stamped as replayed (auditable).
  const row = await db.jobRunDlq.findFirst({ where: { workspaceId } });
  expect(row!.replayedAt).not.toBeNull();
});

test('@smoke cross-workspace isolation: jobs from another workspace are not visible', async ({
  page,
}) => {
  const owner = 'jf-iso-owner@example.com';
  await signUp(page, owner);
  const workspaceA = await workspaceIdFor(owner);

  // Workspace A has many runs; a second workspace B (also the user's) has none.
  for (let i = 0; i < 3; i++) {
    await db.jobRun.create({
      data: {
        workspaceId: workspaceA,
        functionId: 'email.send',
        eventName: 'email.send',
        eventId: `iso-evt-${i}`,
        attempt: 0,
        status: 'succeeded',
        finishedAt: new Date(),
        durationMs: 5,
      },
    });
  }
  const workspaceB = await db.workspace.create({
    data: { name: 'Isolation B', slug: 'jf-iso-b' },
  });
  await db.workspaceMembership.create({
    data: {
      workspaceId: workspaceB.id,
      userId: (await db.user.findFirstOrThrow()).id,
      role: 'owner',
    },
  });

  // Activate workspace B (the RLS + explicit workspace filter must hide A's runs).
  await page
    .context()
    .addCookies([{ name: 'workspace_id', value: workspaceB.id, url: 'http://localhost:3000' }]);
  await gotoJobs(page);
  await expect(page.getByText('No job runs yet')).toBeVisible();
  await expect(page.getByText('email.send')).toHaveCount(0);
});

test('@smoke role gating: a non-owner member sees a disabled Replay with a tooltip', async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000);
  const owner = 'jf-role-owner@example.com';
  const member = 'jf-role-member@example.com';

  // Owner signs up and invites the member.
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);
  await sendInvite(page, member);
  const invite = await waitForEmail(member);
  const acceptUrl = invite.text.match(/https?:\/\/[^\s)]+/)![0];

  // Member signs up in a fresh context and accepts → joins as a `member`.
  const memberCtx: BrowserContext = await browser.newContext();
  const memberPage = await memberCtx.newPage();
  await signUp(memberPage, member);
  await memberPage.goto(acceptUrl);
  await memberPage.getByRole('button', { name: 'Accept invite' }).click();
  await memberPage.waitForURL('**/dashboard');

  // Seed a DLQ row in the shared workspace so the Replay control renders.
  await seedInviteDlqRow({ workspaceId, to: 'role-gate@example.com', idempotencyKey: 'role-1' });

  // The member (now active in the shared workspace) opens the DLQ tab.
  await memberPage.goto('/settings/workspace/jobs');
  await expect(memberPage.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
  await memberPage.getByRole('link', { name: /Dead letter/ }).click();

  // Replay is disabled (the load-bearing gate)…
  const replay = memberPage.getByRole('button', { name: 'Replay' });
  await expect(replay).toBeVisible();
  await expect(replay).toBeDisabled();
  // …with the gating tooltip. Radix mounts tooltip content in a portal only on
  // hover/focus (after a 700ms delay); the disabled button can't receive pointer
  // events, so the component wraps it in a <span> trigger — hover that.
  await replay.locator('xpath=..').hover();
  await expect(memberPage.getByText('Only a workspace owner can replay jobs')).toBeVisible();

  await memberCtx.close();
});

test('@smoke empty states: a fresh workspace shows the documented empty states', async ({
  page,
}) => {
  await signUp(page, 'jf-empty@example.com');

  await gotoJobs(page);
  await expect(page.getByText('No job runs yet')).toBeVisible();
  await page.getByRole('link', { name: /Dead letter/ }).click();
  await expect(page.getByText('Nothing in the dead-letter queue')).toBeVisible();
});
