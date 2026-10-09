import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import {
  agentSession,
  authorPlanOverMcp,
  seedAgentAuthoredPlan,
  AGENT_HARNESS,
  AGENT_MODEL,
  AGENT_PLAN_SEED_PASSWORD,
  type AuthoredLeaf,
} from './_helpers/agent-authored-plan-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';

// THE PLAN REVIEW SHOWS A LEAF'S DIFFICULTY (Story MOTIR-6095 · Subtask
// MOTIR-6142). The story's verification, in a real browser against a production
// build and a real database.
//
// ── PROMOTED FROM THE ACCEPTANCE LANE (Bug MOTIR-6697 · Story MOTIR-6577) ───
//
// This was `acceptance-plan-difficulty.spec.ts`, the receipt for MOTIR-6095.
// That story is `done`, so the spec has discharged its purpose and, per
// docs/decisions/acceptance-receipt-lifecycle.md §3, leaves the lane rather than
// being edited in place. It would have gone RED on MOTIR-6577's merge: MOTIR-6632
// gives the six obsolescence / supersedes patch keys real peek rail rows, so the
// peek's "fields it can set" went 7 → 11. It left the lane by the import swap to
// `_helpers/promoted-regression` (every `chapter()` / `beat()` /
// `acceptanceStory()` call is now inert, none hand-edited), and the ONE assertion
// that recorded the field count is restated on top of the promotion as what
// MOTIR-6095 was about: the re-judge changes exactly ONE field, and exactly one
// rail row — Difficulty — carries the changed mark. The population of settable
// fields is not this story's to pin; `plan-review-difficulty.test.tsx` and the
// peek-projection tests own that number. Main lane, not cloud: the MCP transport
// with a seeded PAT, the plan review, approve and the item page read no cloud
// flag, and the same seed already runs there (`agent-authored-plan.spec.ts`,
// `agent-folder-placement.spec.ts`). Disposition recorded in
// docs/acceptance-lane-triage.md.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A plan an agent wrote arrives with a DIFFICULTY on every leaf it judged. The
// reviewer reads each one before deciding — on the list row, in the peek, on the
// canvas card — reads a re-plan's `Low → High` on the committed subtask it
// re-judges, approves, and finds the same value on the cards that approval
// created and changed.
//
// ── WHAT THIS LANE CANNOT SEE ───────────────────────────────────────────────
//
// The lane does not run motir-ai, so the plan is SEEDED as an agent-authored
// plan over the REAL MCP transport (`add_plan_items` carrying `difficulty`, the
// door MOTIR-6136 opened) rather than produced by a planning pass. That the
// hosted planner judges every leaf is motir-ai's own gate (MOTIR-6145).
//
// ── THE WAITS (CLAUDE.md § E2E tests wait on the AUTHORITATIVE signal) ──────
//
// The review is server-rendered from the seeded plan, so its landmarks (the
// status pill, the proposal list, the canvas) ARE the loaded signal. The one
// write is approve: its POST is armed before the press and its 200 asserted
// before anything reads the tree it produced. Every `beat()` is PACING taken
// after the state it holds on has already been asserted — never a wait.

const STORY = 'Refund requests';
const REASON = {
  trivial: 'one flag renamed in two call sites.',
  low: 'a nullable column and its form field, nothing shared.',
  medium: 'the bounds depend on what was already refunded.',
  high: 'two ledgers must agree under concurrent partial refunds.',
} as const satisfies Record<WorkItemDifficultyDto, string>;

const LEAVES = {
  trivial: 'Rename the refund flag',
  low: 'Add a refund reason field',
  medium: 'Validate refund amounts',
  high: 'Reconcile partial refunds across ledgers',
} as const satisfies Record<WorkItemDifficultyDto, string>;
const UNJUDGED = 'Write the refund help copy';

const COMMITTED_STORY = 'Payments hardening';
const REJUDGED = 'Retry failed refund webhooks';

const LEVELS: WorkItemDifficultyDto[] = ['trivial', 'low', 'medium', 'high'];
const LABEL: Record<WorkItemDifficultyDto, string> = {
  trivial: 'Trivial',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mcpOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  return baseURL;
}

/** One proposal's row on the review's list, found by its one control. `root` is
 *  what the list renders under — the page, or the planning overlay an undecided
 *  plan is reviewed in (Story MOTIR-7883). */
const proposalRow = (page: Page, title: string, root: Page | Locator = page): Locator =>
  root
    .getByTestId('plan-proposal-list')
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: new RegExp(escape(title)) }) });

/** Open a proposal's peek from its list row. */
async function openPeek(page: Page, title: string, root: Page | Locator = page): Promise<Locator> {
  await root
    .getByTestId('plan-proposal-list')
    .getByRole('button', { name: new RegExp(escape(title)) })
    .click();
  const peek = page.getByRole('dialog').getByTestId('proposal-peek');
  await expect(peek).toBeVisible();
  await expect(peek.getByRole('heading', { name: title })).toBeVisible();
  return peek;
}

async function closePeek(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog').getByTestId('proposal-peek')).toBeHidden();
}

/** The peek's rail caption: `Difficulty`, plus the changed mark's
 *  screen-reader word `changed` on a row the plan moves. */
const PEEK_CAPTION = /^Difficulty\s*(changed)?$/;

/** The peek's rail row captioned `Difficulty`. */
const peekDifficulty = (peek: Locator): Locator =>
  peek.locator('dt', { hasText: PEEK_CAPTION }).locator('..');

/** The item page's Difficulty card (MOTIR-6016's field), found by its chevron. */
const difficultyCard = (page: Page): Locator =>
  page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: /^(Edit|Close) Difficulty$/ }) });

const leaf = (difficulty: WorkItemDifficultyDto, extra: Partial<AuthoredLeaf> = {}) => ({
  title: LEAVES[difficulty],
  difficulty,
  descriptionMd: `**Difficulty: ${difficulty}** — ${REASON[difficulty]}`,
  ...extra,
});

test('a plan’s leaves carry a difficulty — read on the review, re-judged on a modify, and written by approve', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  test.setTimeout(240_000);
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-6095');

  await resetDatabase();
  const seed = await seedAgentAuthoredPlan('acceptance-plan-difficulty@example.com');
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };

  // The committed subtask the re-plan re-judges, created BEFORE the plan so
  // nothing about it has drifted by the time the plan is read.
  const committedStory = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'story', title: COMMITTED_STORY },
    ctx,
  );
  const rejudged = await workItemsService.createWorkItem(
    {
      projectId: seed.projectId,
      kind: 'subtask',
      title: REJUDGED,
      parentId: committedStory.id,
      difficulty: 'low',
    },
    ctx,
  );

  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  const authored = await authorPlanOverMcp(client, seed.projectKey, {
    title: 'Refunds, and a webhook re-judged',
    harness: AGENT_HARNESS,
    model: AGENT_MODEL,
    storyTitle: STORY,
    leaves: [
      leaf('trivial'),
      leaf('low'),
      leaf('medium', { storyPoints: 3, estimateMinutes: 45 }),
      leaf('high'),
      { title: UNJUDGED },
    ],
    modifies: [{ workItemId: rejudged.id, patch: { difficulty: 'high' } }],
  });
  await client.close();

  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);

  await chapter('The agent’s plan is waiting in Plans — open it', async () => {
    await page.goto('/plans');
    const row = page.locator(`a[href="/plans/${authored.planId}"]`);
    await expect(row).toHaveAccessibleName('Open the plan — Waiting for approval');
    await row.click();
    await page.waitForURL(`**/plans/${authored.planId}`);
    await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText(
      'Ready to review',
    );
    // Two containers (the new story, the committed one) → it opens on the LIST.
    await expect(page.getByRole('main').getByTestId('plan-proposal-list')).toBeVisible();
  });

  await chapter('Every leaf’s difficulty sits beside its size on the list', async () => {
    for (const level of LEVELS) {
      const fact = proposalRow(page, LEAVES[level]).getByTestId('plan-list-difficulty');
      await expect(fact).toHaveAttribute('data-difficulty', level);
      await expect(fact).toContainText(LABEL[level]);
    }
    // Directly after the points, before the minutes.
    await expect(proposalRow(page, LEAVES.medium)).toContainText(
      /3 pts · (Difficulty )?Medium · 45 min/,
    );
    // The unjudged leaf and the story draw nothing — no placeholder.
    await expect(proposalRow(page, UNJUDGED).getByTestId('plan-list-difficulty')).toHaveCount(0);
    await expect(proposalRow(page, STORY).getByTestId('plan-list-difficulty')).toHaveCount(0);
  });

  await chapter('Open each leaf: Trivial, Low, Medium, High', async () => {
    for (const level of LEVELS) {
      const peek = await openPeek(page, LEAVES[level]);
      const row = peekDifficulty(peek);
      await expect(row).toContainText(LABEL[level]);
      // The item page's own glyph, not a second rendering.
      await expect(row.locator(`[data-difficulty="${level}"]`)).toBeVisible();
      // …and the reason the planner gave, in the body approve will write.
      await expect(peek.getByText(REASON[level])).toBeVisible();
      await beat();
      await closePeek(page);
    }
  });

  await chapter('A leaf left unjudged reads None; the story has no such field', async () => {
    const peek = await openPeek(page, UNJUDGED);
    await expect(peekDifficulty(peek)).toContainText('None');
    await expect(peekDifficulty(peek).locator('[data-difficulty]')).toHaveCount(0);
    await closePeek(page);

    const story = await openPeek(page, STORY);
    await expect(story.locator('dt', { hasText: PEEK_CAPTION })).toHaveCount(0);
    await closePeek(page);
  });

  await chapter('The re-plan re-judges a committed subtask: Low → High', async () => {
    const row = proposalRow(page, REJUDGED);
    const change = row
      .locator('div')
      .filter({ has: page.locator('dt', { hasText: /^Difficulty$/ }) })
      .last();
    await expect(change.locator('dd')).toHaveText(/Low\s*→\s*High/);
    await row.scrollIntoViewIfNeeded();
    await beat();

    const peek = await openPeek(page, REJUDGED);
    const rail = peekDifficulty(peek);
    await expect(rail).toContainText('High');
    await expect(rail.getByTestId('quick-view-changed-mark')).toBeVisible();
    // Restated by MOTIR-6697 (was `…1 of the 7 fields it can set.`): the count of
    // CHANGED fields is this story's claim; the count of SETTABLE fields is not.
    await expect(peek).toContainText(/This plan changes 1 of the \d+ fields it can set\./);
    await expect(peek.getByTestId('quick-view-changed-mark')).toHaveCount(1);
    await beat();
    await closePeek(page);
  });

  await chapter('On the canvas, each new leaf’s card carries it too', async () => {
    await page
      .getByRole('group', { name: 'Plan view' })
      .getByRole('button', { name: 'Canvas' })
      .click();
    await page.waitForURL(`**/plans/${authored.planId}?view=canvas`);
    await expect(page.getByRole('application', { name: 'Proposed plan canvas' })).toBeVisible();
    for (const level of LEVELS) {
      const card = page.locator('[data-node-id]').filter({ hasText: LEAVES[level] });
      await expect(card.getByTestId('plan-item-difficulty')).toHaveAttribute(
        'data-difficulty',
        level,
      );
    }
    await expect(
      page
        .locator('[data-node-id]')
        .filter({ hasText: UNJUDGED })
        .getByTestId('plan-item-difficulty'),
    ).toHaveCount(0);
  });

  await chapter('Approve the plan', async () => {
    const approve = page.getByRole('button', { name: /Approve.*to your backlog/ });
    await expect(approve).toBeVisible();
    const approved = page.waitForResponse(
      (r: Response) =>
        r.url().includes(`/api/plans/${authored.planId}/approve`) &&
        r.request().method() === 'POST',
    );
    await approve.click();
    expect((await approved).status(), 'the approve').toBe(200);
    await expect(page.getByRole('main').getByTestId('plan-status-pill')).toContainText('Approved');
  });

  await chapter('The created High subtask reads High, with its reason', async () => {
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: seed.projectId, title: LEAVES.high },
      select: { identifier: true, difficulty: true },
    });
    expect(created.difficulty, 'approve wrote the difficulty').toBe('high');
    await page.goto(`/items/${created.identifier}`);
    await expect(page.getByRole('heading', { name: LEAVES.high })).toBeVisible();
    await expect(difficultyCard(page)).toContainText('High');
    await expect(page.getByRole('main').getByText(REASON.high)).toBeVisible();
  });

  await chapter('The re-judged subtask reads High, and its history says Low → High', async () => {
    await page.goto(`/items/${rejudged.identifier}?activity=history`);
    await expect(page.getByRole('heading', { name: REJUDGED })).toBeVisible();
    await expect(difficultyCard(page)).toContainText('High');
    const entry = page
      .getByRole('main')
      .locator('p')
      .filter({ hasText: /changed the Difficulty/ })
      .locator('..')
      .filter({ hasText: /high/ });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText('low');
    await entry.scrollIntoViewIfNeeded();
    await beat();
  });
});

test('a plan whose leaves carry no difficulty renders the review without error, empty on every leaf', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await resetDatabase();
  const seed = await seedAgentAuthoredPlan('acceptance-plan-difficulty-empty@example.com');
  const client = await agentSession(seed.token, mcpOrigin(baseURL));
  // The default leaves carry no difficulty — a plan from before the planner judged.
  const authored = await authorPlanOverMcp(client, seed.projectKey, {
    title: 'Payouts, unjudged',
    harness: AGENT_HARNESS,
  });
  await client.close();

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);

  // One container → the canvas.
  //
  // ⚠️ RE-POINTED by Story MOTIR-7883 (MOTIR-7887), 2026-10-08: the plan is
  // undecided, so its review is the planning overlay, which renders the same
  // proposal views; each body is asked for through the helper's switch (the
  // overlay never reads `?view=`).
  const canvas = await openUndecidedPlan(page, authored.planId, { view: 'canvas' });
  for (const title of authored.leafTitles) {
    await expect(canvas.locator('[data-node-id]').filter({ hasText: title })).toHaveCount(1);
  }
  await expect(canvas.getByTestId('plan-item-difficulty')).toHaveCount(0);

  const list = await openUndecidedPlan(page, authored.planId, { view: 'list' });
  await expect(list.getByTestId('plan-proposal-list')).toBeVisible();
  for (const title of authored.leafTitles) {
    await expect(proposalRow(page, title, list)).toBeVisible();
  }
  await expect(list.getByTestId('plan-list-difficulty')).toHaveCount(0);

  for (const title of authored.leafTitles) {
    const peek = await openPeek(page, title, list);
    await expect(peekDifficulty(peek)).toContainText('None');
    await closePeek(page);
  }

  expect(pageErrors, 'the review threw nothing').toEqual([]);
});
