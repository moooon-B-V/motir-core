// Acceptance E2E — a planning conversation is a SESSION from its first turn
// (Subtask MOTIR-6027, Story MOTIR-6011; `agent-authored-plans.md` AMENDMENT 17).
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'), the
// lane where the overlay mounts at all (`isMotirAiConfigured()`), and where the
// motir-ai JOBS boundary is mocked UNDER the routes (`lib/test-ai-jobs-mock.ts`)
// — so a first turn, the session it starts, the plan its submit opens and the
// Plans list that reads them are all REAL rows in Postgres. `acceptanceStory()`
// pins the clip to the story.
//
// ⚠️ ONE DEVIATION FROM THE STORY'S RECIPE, read from the shipped contract. The
// recipe's step 3 expects a card's first message to list as *No plan yet*. A
// message sent from a CARD is a plan-change submit in one call (the MOTIR-909
// anchored door appends AND submits), so its conversation holds a `generating`
// plan the moment it exists and lists as *Writing*. *No plan yet* is what a
// conversation that proposed NOTHING shows — a project-wide question the planner
// answers — and the last chapter shows exactly that.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a landmark, a turn's
// text, a row, a `waitForURL` or the response of a request the page issued. The
// resume window is crossed by moving `lastActivityAt` back (the one input the
// window reads), never by waiting. `beat()` / the chapter hold are PACING only,
// each after the assertion that already proved the state.
import { writeFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import {
  agePlanningSession,
  finishSessionPlan,
  latestPlanningSession,
} from './_helpers/planChangeConversation';
import { usersService } from '@/lib/services/usersService';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

test.describe.configure({ timeout: 180_000 });

const THREE_HOURS = 3 * 60 * 60 * 1000;

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const earlierNotice = (page: Page) => rail(page).getByTestId('planning-earlier-session');
const reopenedLine = (page: Page) => rail(page).getByTestId('planning-reopened-session');
const sessionsList = (page: Page) => page.getByRole('list', { name: 'Planning conversations' });
const rowWith = (page: Page, text: string) =>
  sessionsList(page).getByRole('listitem').filter({ hasText: text });

const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// ── The motir-ai boundary ────────────────────────────────────────────────────

const JOBS_FIXTURE = process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!;

/** What the next ask jobs settle as — an ANSWER, so a question proposes nothing.
 *  The fixture is shared and persistent, so every test resets it. */
function declareAskAnswers(answer: string): void {
  writeFileSync(
    JOBS_FIXTURE,
    JSON.stringify({ ask: [{ intent: 'ask', answer, citations: [] }], submitted: [] }, null, 2),
  );
}

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

/** Open *Plan with AI* from the card, and prove the overlay MOUNTED before
 *  reading anything inside it — a spec that asserts into an unmounted overlay
 *  passes by finding nothing. */
async function openFromCard(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL(overlayOpen);
  await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page)).toBeVisible();
}

async function closeOverlay(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL(overlayClosed);
  await expect(workspace(page)).toHaveCount(0);
}

/** Send a turn from a CARD — the anchored door appends and submits in one call;
 *  its 200 is the authoritative "the session holds this turn". */
async function sendFromCard(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
  await expect(rail(page).getByText(text)).toBeVisible();
}

test.beforeEach(async () => {
  await resetDatabase();
  declareAskAnswers('Nothing is blocked right now.');
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a conversation is kept: come back to it, find it on Plans, start fresh, reopen the older one', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6011');

  const email = `planning-sessions-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const FIRST = 'Split this story so the canvas work can ship on its own.';
  let firstSessionId = '';

  await chapter('Ask about a card, then close the planner', async () => {
    await openFromCard(page, seed.storyKey);
    await sendFromCard(page, FIRST);
    firstSessionId = (await latestPlanningSession(email)).id;
    await beat();
    await closeOverlay(page);
  });

  await chapter('Come back within the window — the same conversation', async () => {
    await openFromCard(page, seed.storyKey);
    await expect(rail(page).getByText(FIRST)).toBeVisible();
    // Resumed, not reopened from the list, and nothing points elsewhere.
    await expect(earlierNotice(page)).toHaveCount(0);
    await expect(reopenedLine(page)).toHaveCount(0);
    await beat();
    await closeOverlay(page);
  });

  await chapter('The Plans page lists the conversation and its plan', async () => {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' })
      .click();
    await page.waitForURL('**/plans');
    const row = rowWith(page, FIRST);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Planning Anchor Owner');
    await expect(row).toContainText(seed.storyKey);
    await expect(row.getByRole('link', { name: 'Open the plan — Writing' })).toBeVisible();
    await beat();

    // The run finishes: the conversation's plan is waiting for a decision, and
    // its chip opens it.
    const planId = await finishSessionPlan(firstSessionId, 'Ship the canvas seam first');
    await page.reload();
    const chip = rowWith(page, FIRST).getByRole('link', {
      name: 'Open the plan — Waiting for approval',
    });
    await expect(chip).toBeVisible();
    await beat();
    await chip.click();
    await page.waitForURL(`**/plans/${planId}`);
    await expect(page.getByTestId('plan-status-pill').first()).toBeVisible();
    await beat();
  });

  await chapter('Hours later, the card opens a fresh conversation', async () => {
    await agePlanningSession(firstSessionId, THREE_HOURS);
    await openFromCard(page, seed.storyKey);
    // Empty — the old turn is not here — and the notice points to it.
    await expect(earlierNotice(page)).toBeVisible();
    await expect(earlierNotice(page)).toContainText('Your earlier conversation about');
    await expect(rail(page).getByText(FIRST)).toHaveCount(0);
    await beat();
  });

  await chapter('Follow the notice — and reopen the earlier conversation', async () => {
    await earlierNotice(page).getByRole('link', { name: 'Plans page' }).click();
    await page.waitForURL(
      (url) => url.pathname === '/plans' && url.searchParams.get('session') === firstSessionId,
    );
    const landed = page.locator(`[data-session-row="${firstSessionId}"] > div`);
    await expect(landed).toBeVisible();
    await expect(landed).toHaveClass(/bg-\(--el-selection-bg\)/);
    await beat();

    await landed.getByRole('link', { name: FIRST }).click();
    await page.waitForURL((url) => url.searchParams.get('planSession') === firstSessionId);
    await expect(workspace(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(rail(page).getByText(FIRST)).toBeVisible();
    await expect(reopenedLine(page)).toContainText('started by you');
    // …with its plan still waiting on the canvas, exactly where it was left.
    await expect(workspace(page).getByTestId('plan-change-confirm-bar')).toBeVisible();
    await beat();
  });

  await chapter('A question that proposes nothing is listed too', async () => {
    const QUESTION = 'What is still blocked in this project?';
    // Leave by address rather than Esc: the reopened conversation holds an
    // unconfirmed proposal, and Esc rightly asks before discarding it.
    await page.goto('/plans');
    await expect(sessionsList(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByRole('link', { name: 'Plan with AI', exact: true }).click();
    await page.waitForURL(overlayOpen);
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const asked = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
    );
    await composer(page).fill(QUESTION);
    await rail(page).getByRole('button', { name: 'Send' }).click();
    expect((await asked).status()).toBe(200);
    await expect(rail(page).getByText('Nothing is blocked right now.')).toBeVisible();
    await closeOverlay(page);

    await page.reload();
    const row = rowWith(page, QUESTION);
    await expect(row).toContainText('No plan yet');
    await expect(row).toContainText('Whole project');
    await beat();
  });
});

test('the Plans page states: no conversations, a filter with none, and a browse-only reader', async ({
  page,
}) => {
  const email = `planning-sessions-states-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  // No conversation at all → the empty state, the ONE place a fresh start is offered.
  await page.goto('/plans');
  await expect(page.getByRole('heading', { name: 'No planning conversations yet' })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByRole('main').getByRole('link', { name: /Plan with AI/ })).toBeVisible();

  // One conversation, then a filter it is not in.
  const FIRST = 'Plan the canvas seam.';
  await openFromCard(page, seed.storyKey);
  await sendFromCard(page, FIRST);
  await closeOverlay(page);
  await page.goto('/plans?planState=approved');
  await expect(page.getByRole('heading', { name: 'No conversations in this state' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Filter conversations by plan state' }),
  ).toBeVisible();

  // A browse-only member sees the list, and the conversation opens READ-ONLY.
  const session = await latestPlanningSession(email);
  const project = await adminDb.project.findFirstOrThrow({
    where: { identifier: seed.projectKey },
  });
  const viewerEmail = `planning-sessions-viewer-${Date.now()}@example.com`;
  const viewer = await usersService.createUser({
    email: viewerEmail,
    password: PLANNING_ANCHOR_PASSWORD,
    name: 'Read Only',
  });
  await adminDb.workspaceMembership.create({
    data: {
      userId: viewer.id,
      workspaceId: session.workspaceId,
      role: 'member',
      activeProjectId: project.id,
    },
  });
  await addToProjectAs({
    key: seed.projectKey,
    actorUserId: session.createdById,
    ctx: { userId: session.createdById, workspaceId: session.workspaceId },
    targetUserId: viewer.id,
    role: 'viewer',
  });

  await page.context().clearCookies();
  await signIn(page, viewerEmail, PLANNING_ANCHOR_PASSWORD);
  await page.goto('/plans');
  const row = rowWith(page, FIRST);
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await row.getByRole('link', { name: FIRST }).click();
  await page.waitForURL((url) => url.searchParams.get('planSession') === session.id);
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(rail(page).getByText(FIRST)).toBeVisible();
  await expect(rail(page).getByTestId('planning-read-only')).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
});
