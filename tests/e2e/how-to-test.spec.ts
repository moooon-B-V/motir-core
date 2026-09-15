import { test, expect, type Locator, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  COMMAND_RUN,
  COMMAND_SETUP,
  PREVIEW_URL,
  openMergeGate,
  seedHowToTest,
  type HowToTestSeed,
} from './_helpers/how-to-test-seed';

// A STORY'S PULL REQUESTS AND ITS RICH-TEXT HOW TO TEST, AS ONE GATE BLOCK
// (Story MOTIR-4906 · Subtask MOTIR-5338).
//
// ── PROMOTED FROM THE ACCEPTANCE LANE (MOTIR-5487) ──────────────────────────
//
// This was `acceptance-how-to-test.spec.ts`, the receipt for MOTIR-4906. That
// story is `done`, so its receipt is frozen and, per
// docs/decisions/acceptance-receipt-lifecycle.md §3, the spec leaves the lane
// rather than being edited in place. It went RED when Story MOTIR-4909
// registered `pull_request_approval` and gave the Development frame its verbs —
// the one stale assertion, "no decision verb exists anywhere in the card", now
// reads what the frame offers the person it is routed to. Every other
// assertion is kept; the receipt's `chapter()` / `beat()` pacing and its
// `acceptanceStory()` tag are gone (`test.step` keeps the structure).
// Disposition recorded in docs/acceptance-lane-triage.md.
//
// ── WHAT IT PROTECTS ────────────────────────────────────────────────────────
//
// A person about to approve a story's merge has ONE place to look: the
// Development block. It holds the story's pull requests and, in the same card,
// the run's How to test — the instructions as rich text with commands a click
// copies, and per repository the preview, the fetch line and what CI proved.
// When the approve-to-merge question is open, that whole block is the gate's
// port under ONE frame (design/github/design-notes.md §20), the way Design
// result is for a design. A child card does not repeat it; it points at the
// story it was tested as part of.
//
// ── SCOPE ───────────────────────────────────────────────────────────────────
//
// No overlay is opened (MOTIR-5214 / 5215), and nothing is pressed: the frame's
// verbs are asserted present, never used. Approving and merging from the frame
// is `acceptance-approve-and-merge.spec.ts` (MOTIR-4909). The gate row is still
// seeded — see `how-to-test-seed.ts` for the full ledger of what is a service
// call and what is a row.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — a role, a count, a URL, the copy control's
// own `data-state`. No timed wait and no fixed sleep anywhere in this file.

test.describe.configure({ timeout: 180_000 });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** The item page's Development card — the section card headed `Development`. */
const developmentCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Development', exact: true }) });

/** How to test, INSIDE the Development card — the part is a labelled group. */
const howToTest = (page: Page): Locator =>
  developmentCard(page).getByRole('group', { name: 'How to test', exact: true });

/** Press a copy control and return what reached the clipboard. The wait is the
 *  control's own `data-state="copied"`, set only after `writeText` resolved. */
async function copyVia(page: Page, control: Locator): Promise<string> {
  await control.click();
  await expect(control).toHaveAttribute('data-state', 'copied');
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe('a story is tested from one Development block', () => {
  let seed: HowToTestSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedHowToTest(Date.now().toString(36));
  });

  test("a story's pull requests and How to test are one gate block, a command copies, a child points to its story", async ({
    page,
  }) => {
    await signIn(page, seed.email, seed.password);

    await test.step('The block: pull requests and How to test in one Development card', async () => {
      await page.goto(`/items/${seed.story.identifier}`);
      const card = developmentCard(page);
      await expect(card).toHaveCount(1, { timeout: 60_000 });

      // Both session pull requests are rows of the card …
      await expect(
        card.getByText('Rate-limit the public API — web', { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByText('Rate-limit the public API — api', { exact: true }),
      ).toBeVisible();

      // … and How to test is INSIDE the same card: the run, the rich-text body
      // with its sections, and one sub-block per repository.
      const part = howToTest(page);
      await expect(part).toHaveCount(1);
      await expect(part.getByText(`Written by ${seed.runLabel}`, { exact: false })).toBeVisible();
      for (const name of ['Precondition', 'Locally', 'Click-path']) {
        await expect(part.getByRole('heading', { name, exact: true })).toBeVisible();
      }

      const web = part.getByRole('group', { name: `${seed.webPr.repo} · #${seed.webPr.number}` });
      const api = part.getByRole('group', { name: `${seed.apiPr.repo} · #${seed.apiPr.number}` });
      await expect(web).toHaveCount(1);
      await expect(api).toHaveCount(1);
      // One repository reported a preview; the link opens the record's
      // `previewPath` on that deployment's URL.
      const previewHref = `${PREVIEW_URL}/items/${seed.story.identifier}`;
      await expect(web.getByRole('link', { name: previewHref })).toHaveAttribute(
        'href',
        previewHref,
      );
      await expect(web.getByText('No preview reported')).toHaveCount(0);
      // The other reported none, and says so.
      await expect(api.getByText('No preview reported', { exact: true })).toBeVisible();
      await expect(api.getByRole('link', { name: previewHref })).toHaveCount(0);
    });

    await test.step('Click to copy: a command in the body, then a repository fetch line', async () => {
      const part = howToTest(page);
      const body = part.locator('.motir-how-to-test');
      const bodyControls = body.getByRole('button', { name: 'Copy code', exact: true });
      await expect(bodyControls).toHaveCount(2);

      await bodyControls.nth(1).scrollIntoViewIfNeeded();
      // EXACT strings — the tab, the quotes, the arrow and the newlines included.
      expect(await copyVia(page, bodyControls.nth(1))).toBe(COMMAND_RUN);
      expect(await copyVia(page, bodyControls.nth(0))).toBe(COMMAND_SETUP);

      const web = part.getByRole('group', { name: `${seed.webPr.repo} · #${seed.webPr.number}` });
      const fetchControl = web.getByRole('button', { name: 'Copy code', exact: true });
      await expect(fetchControl).toHaveCount(1);
      await fetchControl.scrollIntoViewIfNeeded();
      expect(await copyVia(page, fetchControl)).toBe(
        'git fetch origin motir/run-20260913-120000 && git checkout motir/run-20260913-120000',
      );
    });

    await test.step('The one gate: both pull requests and How to test under one frame', async () => {
      await openMergeGate(seed);
      await page.reload();

      const card = developmentCard(page);
      await expect(card).toHaveCount(1, { timeout: 60_000 });
      // ONE frame, whose port holds both rows AND How to test.
      const port = card.getByRole('group', { name: 'The subject being decided', exact: true });
      await expect(port).toHaveCount(1);
      await expect(
        port.getByText('Rate-limit the public API — web', { exact: true }),
      ).toBeVisible();
      await expect(
        port.getByText('Rate-limit the public API — api', { exact: true }),
      ).toBeVisible();
      await expect(port.getByRole('group', { name: 'How to test', exact: true })).toHaveCount(1);
      await expect(card.getByText('Awaiting you', { exact: true })).toBeVisible();

      // How to test carries NO control of its own: every button in it is a copy
      // control.
      const part = howToTest(page);
      const buttons = part.getByRole('button');
      const copies = part.getByRole('button', { name: 'Copy code', exact: true });
      await expect(copies).toHaveCount(4);
      await expect(buttons).toHaveCount(4);
      // The decision verbs belong to the FRAME, once each, for the person it is
      // routed to (MOTIR-4909 registered the kind). Until then this read "no
      // decision verb exists anywhere in the card"; that is the one assertion
      // the promotion changed.
      await expect(
        card.getByRole('button', { name: 'Approve and merge', exact: true }),
      ).toHaveCount(1);
      await expect(card.getByRole('button', { name: 'Request changes', exact: true })).toHaveCount(
        1,
      );
      // No overlay is opened.
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    await test.step('A child card points to the story it was tested as part of', async () => {
      await page.goto(`/items/${seed.child.identifier}`);
      const card = developmentCard(page);
      await expect(card).toHaveCount(1, { timeout: 60_000 });
      await expect(card.getByText('Tested as part of', { exact: false })).toBeVisible();
      // The child repeats nothing: no How to test part of its own.
      await expect(howToTest(page)).toHaveCount(0);
      const pointer = card.getByRole('link', { name: seed.story.identifier, exact: true });

      await pointer.click();
      await expect(page).toHaveURL(new RegExp(`/items/${seed.story.identifier}$`));
      await expect(howToTest(page)).toHaveCount(1, { timeout: 60_000 });
    });

    await test.step('One section: no How to test heading of its own, no pull-request link inside it', async () => {
      // No section in the stack is headed How to test — it is a part of Development.
      await expect(
        page.getByRole('heading', { level: 2, name: 'How to test', exact: true }),
      ).toHaveCount(0);
      const part = howToTest(page);
      await expect(page.getByRole('group', { name: 'How to test', exact: true })).toHaveCount(1);

      // The pull-request links live on the rows, once each — never inside How to test.
      for (const pr of [seed.webPr, seed.apiPr]) {
        await expect(developmentCard(page).locator(`a[href="${pr.url}"]`)).toHaveCount(1);
        await expect(part.locator(`a[href="${pr.url}"]`)).toHaveCount(0);
      }
    });

    await test.step('Record missing: the empty state names the run that owes it', async () => {
      await page.goto(`/items/${seed.owing.identifier}`);
      const card = developmentCard(page);
      await expect(card).toHaveCount(1, { timeout: 60_000 });
      await expect(card.getByText('Export usage as CSV — web', { exact: true })).toBeVisible();

      const part = howToTest(page);
      const missing = part.getByRole('status');
      await expect(missing).toContainText('No run has written how to test this item.');
      await expect(missing).toContainText(
        `Owed by ${seed.owedRunLabel}. The pull requests above still carry their own status.`,
      );
      // It reads differently from a repository that reported no deployment.
      await expect(part.getByText('No preview reported')).toHaveCount(0);
    });
  });
});
