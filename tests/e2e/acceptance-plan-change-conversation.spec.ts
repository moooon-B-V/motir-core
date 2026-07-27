// Acceptance E2E — changing a plan is a CONVERSATION (Subtask MOTIR-1733,
// Story MOTIR-1726).
//
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on') so the
// CI acceptance-video lane records a chaptered clip; `acceptanceStory()` pins the
// recording to Story MOTIR-1726 regardless of the PR that triggered the run.
//
// Drives the story's whole flow from the user's seat, on a project that ALREADY
// has an approved plan — the established-project case that used to dead-end:
//
//   1. "Plan with AI" OPENS the universal workspace (canvas left, chat right).
//      That alone is the regression this story exists to fix — the launcher used
//      to round-trip through `/onboarding` straight back to `/roadmap`.
//   2. A described change streams, and the proposal lands as a DIFF ON THE CANVAS.
//   3. A SECOND turn REFINES it and the diff updates — the assertion that carries
//      the product decision. A one-turn test would not prove the story: the point
//      is that a plan change is a dialogue, not a one-shot prompt.
//   4. Approve commits, and the tree reflects the change.
//   5. The retired one-shot "Augment from prompt" control is gone from `/backlog`
//      and `/items` (test 3).
//
// DETERMINISM (`notes.html` #37 · `motir-core/CLAUDE.md` § E2E waits on the
// authoritative signal). motir-ai has no presence in CI, so the browser→ai hop is
// stubbed via `page.route` — the same open-core seam the shipped
// `acceptance-augment-replan.spec.ts` uses, and the only interceptable one (a
// server-side fetch out of a route handler is NOT reachable from `page.route` —
// mistakes #112 / #152). Everything on THIS side of that hop runs REAL:
//
//   • the conversation thread — `POST /api/ai/plan-change/session` (open/resume)
//     and `…/session/turns` (append) are motir-core + Postgres, so the turns the
//     rail renders are genuinely persisted rows, not stub echoes. The submit stub
//     even re-reads the live session, so the thread is never faked;
//   • the approve — `POST /api/ai/plan-delta/approve` runs through the shipped
//     `aiPlanEditsService.approveDelta`, so the spec asserts real DB state.
//
// Only three things are stubbed: the SUBMIT (which calls motir-ai), the job's SSE
// and the job result. The streaming state is observed by HOLDING the job-result
// route until the assertion has run — an authoritative gate, never a timeout.

import { test, expect } from './_helpers/acceptance-video';
import type { Page, Route } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  PLAN_CHANGE_JOB_ID,
  PLAN_CHANGE_REFINE_JOB_ID,
} from './_helpers/ai-augment-replan-seed';

test.describe.configure({ timeout: 120_000 });

// ── The proposal motir-ai would return, per turn ─────────────────────────────
//
// Both creates are ROOT proposals (no `parentKey` / `parentRef`), so they land on
// the canvas's TOP level and the diff is visible without drilling. `story` carries
// no `type` — that is leaf-only (the 2.7.2 ADR; an epic/story with a type is
// rejected 422 by the approve).

const ADDED_TITLE = 'Billing';
const REFINED_TITLE = 'Reporting';
const RENAMED_NOTIF = 'Notifications & alerts';

/** Turn 1 — one addition plus a rename of an existing (non-terminal) root item. */
function firstDelta(notifKey: string) {
  return {
    operations: [
      { op: 'create', kind: 'story', fields: { title: ADDED_TITLE } },
      { op: 'update', targetKey: notifKey, fields: { title: RENAMED_NOTIF } },
    ],
  };
}

/** Turn 2 — the SAME intent, refined: a second addition. The counts move 1 → 2,
 *  which is what proves the canvas re-rendered the NEW proposal. */
function refinedDelta(notifKey: string) {
  return {
    operations: [
      { op: 'create', kind: 'story', fields: { title: ADDED_TITLE } },
      { op: 'create', kind: 'story', fields: { title: REFINED_TITLE } },
      { op: 'update', targetKey: notifKey, fields: { title: RENAMED_NOTIF } },
    ],
  };
}

// ── Stubs for the browser→motir-ai boundary ──────────────────────────────────

const AI_ACCESS_NA = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_ACCESS_NA),
    });
  });
}

/**
 * Stub the SUBMIT — the one hop in the conversation that reaches motir-ai. Each
 * call hands back the next job id, so turn 2 settles on a different delta.
 *
 * The `session` it returns is the REAL one, re-read through the idempotent
 * open/resume endpoint: the rail replaces its session with this response, so
 * echoing a hand-built thread would erase the turns the app actually persisted
 * and the multi-turn assertion would be testing the stub. Only the motir-ai half
 * is faked.
 */
async function stubPlanChangeSubmit(page: Page, jobIds: readonly string[]): Promise<void> {
  let call = 0;
  await page.route('**/api/ai/plan-change/session/submit', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const jobId = jobIds[Math.min(call, jobIds.length - 1)]!;
    call += 1;
    const sessionUrl = new URL('/api/ai/plan-change/session', route.request().url()).toString();
    const live = await route.fetch({ url: sessionUrl });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId, session: await live.json() }),
    });
  });
}

/** The augment job's SSE, carrying the REAL frame vocabulary the rail narrates
 *  (`search` / `planned` / `done`) — structured progress, not assistant tokens. */
function progressSse(proposed: number): string {
  return (
    `event: search\ndata: {}\n\n` +
    `event: planned\ndata: {"proposed":${proposed}}\n\n` +
    `event: done\ndata: {}\n\n`
  );
}

async function stubStream(page: Page, jobId: string, body: string): Promise<void> {
  await page.route(`**/api/ai/augment/${jobId}/stream`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
}

/**
 * Stub a job's result read, GATED: the route does not answer until the returned
 * `release()` is called. That makes the STREAMING state deterministically
 * observable — the run cannot advance past a request the test is holding — so the
 * narration is asserted against an authoritative gate rather than a timeout
 * (`motir-core/CLAUDE.md` § E2E waits on the authoritative signal).
 */
async function stubGatedJobResult(page: Page, jobId: string, delta: object): Promise<() => void> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await page.route(`**/api/ai/jobs/${jobId}`, async (route: Route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'completed', result: { planDelta: delta } }),
    });
  });
  return open;
}

async function stubJobResult(page: Page, jobId: string, delta: object): Promise<void> {
  await page.route(`**/api/ai/jobs/${jobId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'completed', result: { planDelta: delta } }),
    });
  });
}

// ── Locators ─────────────────────────────────────────────────────────────────

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => page.getByRole('textbox', { name: /Reply, or refine/ });
const confirmBar = (page: Page) => page.getByTestId('plan-change-confirm-bar');
const canvas = (page: Page) => page.getByTestId('roadmap-canvas');

/** Type a turn and send it, waiting on the APPEND's 200 — the turn is a persisted
 *  row, so its write response is the authoritative "the thread advanced" signal. */
async function sendTurn(page: Page, text: string): Promise<void> {
  const appended = page.waitForResponse(
    (r) => r.url().includes('/api/ai/plan-change/session/turns') && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await appended).status()).toBe(200);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// The recorded happy path — it carries the chapter markers the acceptance
// video's timeline is built from.
test('plan change is a conversation — open, describe, refine, approve', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1726');
  const seed = await seedAiAugmentReplan(`plan-change-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  await stubAiAccess(page);
  await stubPlanChangeSubmit(page, [PLAN_CHANGE_JOB_ID, PLAN_CHANGE_REFINE_JOB_ID]);
  await stubStream(page, PLAN_CHANGE_JOB_ID, progressSse(1));
  await stubStream(page, PLAN_CHANGE_REFINE_JOB_ID, progressSse(2));
  const releaseFirstResult = await stubGatedJobResult(
    page,
    PLAN_CHANGE_JOB_ID,
    firstDelta(seed.notifKey),
  );
  await stubJobResult(page, PLAN_CHANGE_REFINE_JOB_ID, refinedDelta(seed.notifKey));

  await signIn(page, seed.email, seed.password);

  await chapter('Plan with AI opens the workspace', async () => {
    // The REAL door: the header's hero launcher, present on every authed screen.
    // Before MOTIR-1729 this href dead-ended on an established project.
    await page.getByRole('link', { name: 'Plan with AI' }).first().click();
    await page.waitForURL(/\/planning\?/);

    // Two panes: the project's existing plan on the canvas, the conversation on
    // the right. The EMPTY state — a thread with no turns yet — is not a blank
    // screen: the canvas already shows the plan, and the rail opens the topic.
    await expect(canvas(page)).toBeVisible();
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).getByText('What should change?')).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Add work to an epic' })).toBeVisible();
    await expect(confirmBar(page)).toHaveCount(0);
    await expect(page.getByTestId('plan-change-diff-node')).toHaveCount(0);
  });

  await chapter('Describe the change — it lands on the canvas', async () => {
    await sendTurn(page, 'Add a billing epic and rename the notifications story.');

    // STREAMING: the job result is held, so the run is parked mid-flight and the
    // rail's live region shows the narration built from the SSE's real frames.
    await expect(page.getByTestId('plan-change-progress')).toContainText(/proposed so far/);
    releaseFirstResult();

    // REVIEW: the proposal is on the CANVAS, not in a corner dock, and nothing is
    // saved until it is approved.
    await expect(confirmBar(page)).toContainText('1 added, 1 changed');
    await expect(confirmBar(page)).toContainText('Nothing is saved until you approve.');
    await expect(canvas(page).getByText(ADDED_TITLE, { exact: true })).toBeVisible();
    await expect(page.locator('[data-diff-state="add"]')).toHaveCount(1);
    // The existing item the proposal renames wears the CHANGE frame in place.
    await expect(page.locator('[data-diff-state="change"]')).toHaveCount(1);
  });

  await chapter('Refine in a second turn — the diff updates', async () => {
    await sendTurn(page, 'Also add reporting, and keep both at story level.');

    // The thread is a conversation: turn 2 is labelled a REFINEMENT of turn 1,
    // and both turns are still on it (they are persisted rows, not UI state).
    await expect(rail(page).getByText('turn 2 · refine')).toBeVisible();
    await expect(rail(page).getByText('turn 1')).toBeVisible();

    // The SECOND delta replaced the first on the canvas — the counts moved.
    await expect(confirmBar(page)).toContainText('2 added, 1 changed');
    await expect(canvas(page).getByText(REFINED_TITLE, { exact: true })).toBeVisible();
    await expect(page.locator('[data-diff-state="add"]')).toHaveCount(2);
  });

  await chapter('Approve — the plan changes', async () => {
    const approved = page.waitForResponse(
      (r) => r.url().includes('/api/ai/plan-delta/approve') && r.request().method() === 'POST',
    );
    await confirmBar(page).getByRole('button', { name: 'Approve changes' }).click();
    expect((await approved).status()).toBe(200);

    // The rail says what landed and KEEPS the thread — a plan change is rarely
    // one change, so the conversation stays open.
    await expect(rail(page).getByText(/Added 2 work items, changed 1/)).toBeVisible();
    await expect(composer(page)).toBeEnabled();

    // The proposal is gone from the canvas and the committed items are drawn in
    // its place — the client island refetched (it seeds its level once, so
    // `router.refresh()` alone could not have reached it).
    await expect(confirmBar(page)).toHaveCount(0);
    await expect(page.getByTestId('plan-change-diff-node')).toHaveCount(0);
    await expect(canvas(page).getByText(REFINED_TITLE, { exact: true })).toBeVisible();

    // The real substrate: the tree reflects the change.
    const added = await db.workItem.findMany({
      where: { projectId: seed.projectId, title: { in: [ADDED_TITLE, REFINED_TITLE] } },
      orderBy: { title: 'asc' },
    });
    expect(added).toHaveLength(2);
    for (const item of added) {
      expect(item.kind).toBe('story');
      expect(item.parentId).toBeNull();
    }
    const renamed = await db.workItem.findFirst({
      where: { projectId: seed.projectId, identifier: seed.notifKey },
    });
    expect(renamed?.title).toBe(RENAMED_NOTIF);
  });
});

test('a failed run is recoverable in place — the thread and the retry survive', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1726');
  const seed = await seedAiAugmentReplan(`plan-change-error-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  // One job id for both attempts; the STREAM fails first and succeeds on retry.
  let failing = true;
  await stubAiAccess(page);
  await stubPlanChangeSubmit(page, [PLAN_CHANGE_JOB_ID]);
  await page.route(`**/api/ai/augment/${PLAN_CHANGE_JOB_ID}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: failing ? `event: error\ndata: {"code":"FAILED"}\n\n` : progressSse(1),
    });
  });
  await stubJobResult(page, PLAN_CHANGE_JOB_ID, firstDelta(seed.notifKey));

  await signIn(page, seed.email, seed.password);
  await page.goto('/planning?mode=replan&from=project');
  await expect(rail(page)).toBeVisible();

  await sendTurn(page, 'Split the settings epic into smaller stories.');

  // The failure is stated, and it is RECOVERABLE: the turn is still on the thread
  // and "Try again" re-sends the accumulated intent rather than restarting.
  await expect(rail(page).getByRole('alert')).toContainText(/didn't go through/);
  await expect(rail(page).getByText('turn 1')).toBeVisible();
  await expect(confirmBar(page)).toHaveCount(0);

  failing = false;
  await rail(page).getByRole('button', { name: 'Try again' }).click();

  // Same conversation, now settled: the proposal is on the canvas.
  await expect(confirmBar(page)).toContainText('1 added, 1 changed');
  await expect(rail(page).getByRole('alert')).toHaveCount(0);
});

test('the one-shot "Augment from prompt" door is gone from /backlog and /items', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1726');
  const seed = await seedAiAugmentReplan(`plan-change-retired-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);

  await signIn(page, seed.email, seed.password);

  // Each page is asserted LOADED first — an absence assertion on a page that
  // never rendered would pass vacuously.
  await page.goto('/backlog');
  await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Augment from prompt/i })).toHaveCount(0);

  await page.goto('/items');
  await expect(page.getByRole('heading', { name: 'Work Items' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Augment from prompt/i })).toHaveCount(0);

  // The conversational door is what replaced it — present on both surfaces.
  await expect(page.getByRole('link', { name: 'Plan with AI' }).first()).toBeVisible();
});
