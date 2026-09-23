import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { AGENT_PLAN_SEED_PASSWORD } from './_helpers/agent-authored-plan-seed';
import {
  PROPOSED_STORY,
  REMOVE_REASON,
  Z_BODY,
  Z_RENAMED,
  seedSurgicalPlan,
  type SurgicalPlanSeed,
} from './_helpers/surgical-plan-seed';

// THE SURGICAL PLAN, REVIEWED AND APPROVED — THE ACCEPTANCE RECEIPT (Story
// MOTIR-6013 · Subtask MOTIR-6058).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A planner wrote ONE plan through the real MCP tools that does three surgical
// things to cards outside the tree it was laying: it proposes a new story and
// MOVES a committed card under it, it UPDATES a card in another epic twice (one
// change, merged), and it REMOVES an obsolete card, saying why. The clip reads it
// the way the person approving it would:
//
//   1. the moved card is named under `New · <story title>` — never an internal
//      `planItem:` id, which is what rendered before this story;
//   2. the twice-updated card is ONE change carrying both edits;
//   3. the removed card says WHY, in the list, on the canvas and in its peek;
//   4. approve lands all three — the story exists with the card under it, the
//      update is applied, and the obsolete card is archived.
//
// The planner's own LLM run is not in this lane (motir-ai is not reachable from
// here); its half is the motir-ai integration gate, MOTIR-6063.

const planRow = (page: Page, planId: string) => page.locator(`a[href="/plans/${planId}"]`);
/** The live page body — every locator is scoped, never page-rooted (MOTIR-5037). */
const main = (page: Page) => page.getByRole('main');
const canvasOf = (page: Page) => main(page).getByTestId('roadmap-canvas');
const statusPill = (page: Page) => main(page).getByTestId('plan-status-pill');
/** The proposal peek is a modal, portalled outside `main`. */
const peekOf = (page: Page) => page.getByRole('dialog').getByTestId('proposal-peek');
const nodeOf = (canvas: Locator, nodeId: string) => canvas.locator(`[data-node-id="${nodeId}"]`);

/** A proposal's door in the list body — named `Open <KEY> · <title>`. */
const openButton = (page: Page, card: { identifier: string }, title: string) =>
  page.getByRole('button', { name: `Open ${card.identifier} · ${title}`, exact: true });

/** The plan's list body — one row per proposal, found by its door. */
const listRow = (page: Page, card: { identifier: string }, title: string) =>
  openButton(page, card, title).locator('xpath=ancestor::li[1]');

/** The shipped List / Canvas switch — a labelled group of pressed buttons. */
const viewButton = (page: Page, name: 'List' | 'Canvas') =>
  page.getByRole('main').getByRole('button', { name, exact: true });

async function toList(page: Page) {
  await viewButton(page, 'List').click();
  await expect(main(page).getByTestId('plan-proposal-list')).toBeVisible();
}

async function openSeed(page: Page, baseURL: string | undefined): Promise<SurgicalPlanSeed> {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  await resetDatabase();
  const seed = await seedSurgicalPlan('surgical-plan@example.com', baseURL);
  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);
  return seed;
}

test('a plan that moves, updates and removes cards outside its tree reads plainly and approves', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6013');
  const seed = await openSeed(page, baseURL);

  await chapter('The plan the agent wrote is waiting in Plans', async () => {
    const plansNav = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Plans' });
    await plansNav.click();
    await page.waitForURL('**/plans');
    await expect(planRow(page, seed.planId)).toBeVisible();
    await beat();
    await planRow(page, seed.planId).click();
    await page.waitForURL(`**/plans/${seed.planId}**`);
    await expect(statusPill(page)).toContainText('Ready to review');
    // No internal temp-ref reaches the page — anywhere.
    await expect(page.getByText(/planItem:/)).toHaveCount(0);
    await beat();
  });

  await chapter(
    'Show changes — the move names the proposed story, the update is ONE change',
    async () => {
      await toList(page);
      const moved = listRow(page, seed.x, seed.x.title);
      await expect(moved).toContainText('Parent');
      await expect(moved).toContainText(seed.fStory.identifier);
      await expect(moved).toContainText(`New · ${PROPOSED_STORY}`);
      await beat();

      // Z was updated twice; the plan holds ONE proposal carrying both edits.
      await expect(openButton(page, seed.z, Z_RENAMED)).toHaveCount(1);
      const updated = listRow(page, seed.z, Z_RENAMED);
      await expect(updated).toContainText('Title');
      await expect(updated).toContainText('Description');
      await beat();

      const removed = listRow(page, seed.y, seed.y.title);
      await expect(removed.getByTestId('remove-reason')).toContainText('Reason');
      await expect(removed.getByTestId('remove-reason')).toContainText(REMOVE_REASON);
      await expect(page.getByText(/planItem:/)).toHaveCount(0);
      await beat();
    },
  );

  await chapter('On the canvas, the removal carries its reason', async () => {
    await viewButton(page, 'Canvas').click();
    const canvas = canvasOf(page);
    // The plan fills the Invoices level most (the update and the removal).
    const removedNode = nodeOf(canvas, seed.y.id);
    await expect(removedNode).toBeVisible();
    await expect(removedNode.getByTestId('remove-reason')).toContainText(
      REMOVE_REASON.slice(0, 20),
    );
    await expect(removedNode.getByTestId('remove-reason').locator('[title]')).toHaveAttribute(
      'title',
      REMOVE_REASON,
    );
    await beat();
  });

  await chapter('The peeks: why the card goes, and both edits marked', async () => {
    await toList(page);
    await openButton(page, seed.y, seed.y.title).click();
    const peek = peekOf(page);
    await expect(peek).toBeVisible();
    await expect(peek.getByTestId('remove-reason')).toContainText(REMOVE_REASON);
    await beat();
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);

    await openButton(page, seed.z, Z_RENAMED).click();
    await expect(peekOf(page)).toBeVisible();
    await expect(peekOf(page)).toContainText(Z_RENAMED);
    await expect(peekOf(page)).toContainText('A retry waits twice as long');
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('Approve — the three edits land', async () => {
    const approved = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/plans/${seed.planId}/approve`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Approve/ }).click();
    expect((await approved).status()).toBe(200);
    await expect(statusPill(page)).toContainText('Approved');

    // The decided list names the CREATED story by its key now.
    const story = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: seed.projectId, title: PROPOSED_STORY },
    });
    await toList(page);
    await expect(listRow(page, seed.x, seed.x.title)).toContainText(story.identifier);
    await beat();
  });

  await chapter(
    'The moved card sits under the new story; the update and the removal applied',
    async () => {
      const story = await adminDb.workItem.findFirstOrThrow({
        where: { projectId: seed.projectId, title: PROPOSED_STORY },
      });
      await page.goto(`/items/${seed.x.identifier}`);
      const parents = page.getByRole('navigation', { name: 'Parent work items' });
      await expect(parents.getByRole('link', { name: `Story: ${PROPOSED_STORY}` })).toHaveAttribute(
        'href',
        `/items/${story.identifier}`,
      );
      await beat();

      await page.goto(`/items/${seed.z.identifier}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toContainText(Z_RENAMED);
      await expect(main(page).getByText(Z_BODY.split('- ')[1]!)).toBeVisible();
      await beat();

      await page.goto(`/items/${seed.y.identifier}`);
      await expect(page.getByText('Archived').first()).toBeVisible();
      await beat();
    },
  );
});

test('a remove with no reason draws no reason line', async ({ page, baseURL, acceptanceStory }) => {
  acceptanceStory('MOTIR-6013');
  const seed = await openSeed(page, baseURL);
  await page.goto(`/plans/${seed.bareRemovePlanId}?view=list`);
  await expect(openButton(page, seed.w, seed.w.title)).toBeVisible();
  await expect(main(page).getByTestId('remove-reason')).toHaveCount(0);
  await page.goto(`/plans/${seed.bareRemovePlanId}?view=canvas`);
  await expect(nodeOf(canvasOf(page), seed.w.id)).toBeVisible();
  await expect(main(page).getByTestId('remove-reason')).toHaveCount(0);
});

test('approve refuses a move whose proposed parent became illegal, and creates nothing', async ({
  page,
  baseURL,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6013');
  const seed = await openSeed(page, baseURL);
  await page.goto(`/plans/${seed.illegalPlanId}?view=list`);
  const refused = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.illegalPlanId}/approve`) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Approve/ }).click();
  expect((await refused).status()).toBe(400);
  // The rail's refusal line (the route announcer is also an `alert`, and empty).
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toBeVisible();
  await expect(statusPill(page)).not.toContainText('Approved');
  expect(
    await adminDb.workItem.count({ where: { projectId: seed.projectId, title: 'Dunning' } }),
  ).toBe(0);
  const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: seed.illegalCard.id } });
  expect(card.parentId).toBe(seed.fStory.id);
});
