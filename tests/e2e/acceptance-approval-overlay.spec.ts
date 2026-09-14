import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import { openAgentSession, publishDesignResult } from './_helpers/design-approval-seed';
import {
  plantFillerGates,
  seedApprovalsTab,
  STORY_TITLE_EXPORT,
  type ApprovalsTabSeed,
} from './_helpers/approvals-tab-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// DECIDE IT FULL SCREEN, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-5214 · Subtask MOTIR-5227).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person with a queue of decisions clicks one, and the thing being decided
// fills the screen — not a port a few hundred pixels tall inside a list row.
// They approve it there, and closing puts them back on exactly the page they
// left: the same page of the list, the same scroll, one decision fewer.
//
// ── WHAT ONLY AN E2E CAN PROVE ──────────────────────────────────────────────
//
// The RETURN. The overlay's open state is the address and its close is a
// `shallowPush`, so the tab underneath is never re-rendered by the navigation.
// A unit test has no scroll position and no history stack, so the scroll, the
// page of the list and browser Back are asserted here and nowhere else.
//
// ── SITS BESIDE `acceptance-approvals-tab.spec.ts`, NOT INSIDE IT ───────────
//
// That spec is MOTIR-4879's receipt (the tab), re-scoped by MOTIR-5225 to decide
// through the overlay. This one is MOTIR-5214's receipt (the overlay), and it
// owns what that one does not assert: band 2 at full size, the decided record
// inside the overlay, the scroll and page on return, Back, a pasted address, and
// the walk in `zh`.
//
// ⚠️ THE DECIDED ROW LEAVES ON THE DECISION'S OWN REFRESH, and this spec asserts
// that rather than a row "settled in place" after the close. The decide action
// revalidates `/workbench` and the overlay refreshes, and the queue's read
// returns only `awaiting` gates — so the refreshed page no longer holds the row.
// That is the behaviour MOTIR-4879's receipt already recorded for the in-list
// disclosure (its row count reaches 0 in the same state as the badge), and it is
// recorded on MOTIR-5225 against design-notes § 22's wording.
//
// ⚠️ WHAT IS PUBLISHED FOR REAL: the design under test, through
// `publish_design_result` over `/api/mcp`. The 25 filler gates that make the
// queue two pages are written by `plantFillerGates`, whose header states that
// trade; nothing here decides one or asserts on its content.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — the named dialog (its name is set only when
// the read answers), the decide action's response, the row count, the URL. The
// holds are `chapter()`'s pacing, taken after each state is proven.

test.describe.configure({ timeout: 300_000 });

/** The queue's rows, scoped to the TABLE (named for the tab) rather than rooted at
 *  the page — `tests/e2e-page-rooted-locators.test.ts` admits no new page-rooted
 *  test-id locator, and the table is the live subtree the rows belong to. */
const queue = (page: Page, tab: string) => page.getByRole('table', { name: tab });
const rowsIn = (page: Page, tab: string) => queue(page, tab).getByTestId(/^approval-row-/);
const rows = (page: Page) => rowsIn(page, en.workbench.tabs.toApprove);

/** The strip's To-approve badge, as a number — a suppressed zero is zero. */
async function badgeCount(page: Page, tab: RegExp): Promise<number> {
  const text = (await page.getByRole('link', { name: tab }).textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** A row's whole-row door. Clicked at its left edge: its centre sits under the
 *  work-item link, which is the one control above it on purpose. */
async function openRow(row: Locator): Promise<void> {
  await row.getByRole('link', { name: /^(Review|查看) / }).click({ position: { x: 8, y: 22 } });
}

/** The scroll offset of whatever element scrolls the list. */
async function listScroll(row: Locator): Promise<number> {
  return row.evaluate((el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const overflowY = getComputedStyle(n).overflowY;
      if (/(auto|scroll)/.test(overflowY) && n.scrollHeight > n.clientHeight) return n.scrollTop;
    }
    return document.scrollingElement?.scrollTop ?? 0;
  });
}

const onTheTab = (url: URL) => url.pathname === '/workbench' && url.search === '?tab=approvals';

test.describe('an approval, decided full screen over the page you are on', () => {
  let seed: ApprovalsTabSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsTab(`ov${Date.now().toString(36)}`);
  });

  test('open a waiting design from its row, approve it there, and close back to exactly where you were', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5214');
    await servePrivateObjectStore(page);

    const client = await openAgentSession(seed.token, baseURL!);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    await client.close();
    // Twenty-five more make the queue two pages, so "back to exactly where you
    // were" is a claim about a paged, scrolled list and not a bare route.
    await plantFillerGates(seed, STORY_TITLE_EXPORT, 25);

    const toApprove = new RegExp(en.workbench.tabs.toApprove);
    const designDialog = page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });
    const designRow = rows(page).filter({ hasText: seed.designTitle });

    await chapter('Twenty-six decisions are waiting, and the tab says so', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto('/workbench?tab=approvals');
      await expect(rows(page)).toHaveCount(25);
      await expect(designRow).toHaveCount(1);
      expect(await badgeCount(page, toApprove)).toBe(26);
    });

    await chapter('Clicking the row fills the screen with the design', async () => {
      await openRow(designRow);
      await expect(designDialog).toBeVisible();
      // The tab is never left: the address only gains the overlay's two names.
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === '/workbench' &&
          url.searchParams.get('tab') === 'approvals' &&
          url.searchParams.get('approval') === seed.designKey &&
          url.searchParams.get('approvalKind') === 'design_result',
      );
      // BAND 2, AT FULL SIZE — the port runs edge to edge under the exit row,
      // which a port inside a list row cannot.
      const port = designDialog.getByRole('group', { name: en.approvalGate.port.label });
      await expect(port).toBeVisible();
      const box = (await port.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.width).toBeGreaterThan(viewport.width * 0.9);
      expect(box.height).toBeGreaterThan(viewport.height * 0.5);
    });
    await beat();

    await chapter('Approving it there shows the decided record, in place', async () => {
      await designDialog
        .getByRole('button', { name: en.approvalGate.verb.approve, exact: true })
        .click();
      await expect(designDialog.getByText(en.approvalGate.confirm.title)).toBeVisible();
      const decided = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await designDialog.getByRole('button', { name: 'Yes, Approve' }).click();
      expect((await decided).status()).toBe(200);
      // Drawn from the gate row the action RETURNED — the decision is recorded.
      await expect(
        designDialog.getByText(en.approvalGate.state.approved, { exact: true }),
      ).toBeVisible();
      await expect(
        designDialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }),
      ).toHaveCount(0);
    });
    await beat();

    await chapter('Esc returns to the tab, one decision fewer, in one page state', async () => {
      await page.keyboard.press('Escape');
      await expect(designDialog).toBeHidden();
      await expect(page).toHaveURL(onTheTab);
      // AUTHORITATIVE: the decided row has left the queue…
      await expect(designRow).toHaveCount(0, { timeout: 30_000 });
      // …and the rows and the badge agree, read in the SAME state.
      await expect(rows(page)).toHaveCount(25);
      expect(await badgeCount(page, toApprove)).toBe(25);
    });
    await beat();

    await chapter('Closing lands on the same page of the list, at the same scroll', async () => {
      const last = rows(page).last();
      const lastId = (await last.getAttribute('data-testid'))!;
      await last.scrollIntoViewIfNeeded();
      const before = await listScroll(last);
      expect(before).toBeGreaterThan(0);

      // A filler's subject does not resolve, so this opens § 22's subject-gone
      // arm — every row has the door, whatever its subject.
      await openRow(last);
      const gone = page.getByRole('dialog', { name: /^Design result for / });
      await expect(gone).toBeVisible();
      await expect(gone.getByText(en.approvalOverlay.subjectGone.body)).toBeVisible();
      await gone
        .getByRole('button', { name: /^Close/ })
        .first()
        .click();

      await expect(gone).toBeHidden();
      await expect(page).toHaveURL(onTheTab);
      const again = queue(page, en.workbench.tabs.toApprove).getByTestId(lastId);
      await expect(again).toBeVisible();
      expect(await listScroll(again)).toBe(before);
    });
    await beat();

    await chapter('Browser Back closes it too, and lands on the tab', async () => {
      await openRow(rows(page).first());
      const opened = page.getByRole('dialog', { name: /^Design result for / });
      await expect(opened).toBeVisible();
      await page.goBack();
      await expect(opened).toBeHidden();
      await expect(page).toHaveURL(onTheTab);
      await expect(rows(page)).toHaveCount(25);
    });
    await beat();

    await chapter('A pasted address for a gate that does not exist opens and says so', async () => {
      await page.goto('/workbench?tab=approvals&approval=QUEUE-99999&approvalKind=design_result');
      const refused = page.getByRole('dialog', { name: en.approvalOverlay.notAvailable.title });
      await expect(refused).toBeVisible();
      await expect(refused.getByText(en.approvalOverlay.notAvailable.body)).toBeVisible();
      await refused.getByRole('button', { name: en.common.close, exact: true }).click();
      await expect(refused).toBeHidden();

      // The page behind it was rendered all along, and it still answers.
      await expect(rows(page)).toHaveCount(25);
      await rows(page)
        .first()
        .getByRole('link', { name: /^Review / })
        .press('Enter');
      await expect(page.getByRole('dialog', { name: /^Design result for / })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  });

  test('a reader who may SEE a decision but not make it reaches the design and no verbs', async ({
    page,
    baseURL,
    chapter,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5214');
    await servePrivateObjectStore(page);

    // A project `viewer` who is the ASSIGNEE: routed the gate, held out of
    // deciding it by the kind's permission floor (`approvals-tab-seed.ts`).
    const viewerCard = await adminDb.workItem.findUniqueOrThrow({
      where: { id: seed.viewerDesignId },
      select: { identifier: true },
    });
    const client = await openAgentSession(seed.token, baseURL!);
    expect((await publishDesignResult(client, viewerCard.identifier)).isError ?? false).toBe(false);
    await client.close();

    await chapter('The viewer opens the one decision routed to them', async () => {
      await signIn(page, seed.viewerEmail, seed.password);
      await page.goto('/workbench?tab=approvals');
      await expect(rows(page)).toHaveCount(1);
      await expect(
        rows(page).getByRole('button', { name: en.workbench.approvals.review, exact: true }),
      ).toHaveCount(0);

      await openRow(rows(page).first());
      const dialog = page.getByRole('dialog', {
        name: `${en.workbench.approvals.kind.design_result} for ${viewerCard.identifier}`,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('group', { name: en.approvalGate.port.label })).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole('button', { name: en.approvalGate.verb.requestChanges }),
      ).toHaveCount(0);
    });
  });

  test('the same walk in Chinese', async ({ page, baseURL, chapter, beat, acceptanceStory }) => {
    acceptanceStory('MOTIR-5214');
    await servePrivateObjectStore(page);

    const client = await openAgentSession(seed.token, baseURL!);
    expect((await publishDesignResult(client, seed.designKey)).isError ?? false).toBe(false);
    await client.close();

    const toApprove = new RegExp(zh.workbench.tabs.toApprove);
    const dialog = page.getByRole('dialog', {
      name: `${seed.designKey} 的${zh.workbench.approvals.kind.design_result}`,
    });

    await signIn(page, seed.reviewerEmail, seed.password);
    // The suite's own locale switch (`workbench.spec.ts`).
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);

    await chapter('待审批 — the row opens the design full screen', async () => {
      await page.goto('/workbench?tab=approvals');
      await expect(page.getByRole('link', { name: toApprove })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await openRow(rowsIn(page, zh.workbench.tabs.toApprove).first());
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('group', { name: zh.approvalGate.port.label })).toBeVisible();
      await expect(
        dialog.getByRole('link', { name: zh.approvalOverlay.openWorkItem }),
      ).toHaveAttribute('href', `/items/${seed.designKey}`);
      // Asserted through the catalogue's own strings, and negatively too.
      await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    });
    await beat();

    await chapter('批准 — and the decided record, in Chinese', async () => {
      await dialog.getByRole('button', { name: zh.approvalGate.verb.approve, exact: true }).click();
      await expect(dialog.getByText(zh.approvalGate.confirm.title)).toBeVisible();
      const decided = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await dialog
        .getByRole('button', {
          name: zh.approvalGate.confirm.proceed.replace('{verb}', zh.approvalGate.verb.approve),
        })
        .click();
      expect((await decided).status()).toBe(200);
      await expect(dialog.getByText(zh.approvalGate.state.approved, { exact: true })).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(onTheTab);
      // The queue emptied: the tab draws its empty state, and the badge is gone.
      await expect(
        page.getByRole('heading', { name: zh.workbench.empty.approvals.title }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(queue(page, zh.workbench.tabs.toApprove)).toHaveCount(0);
      expect(await badgeCount(page, toApprove)).toBe(0);
    });
    await beat();

    await chapter('A pasted address that names nothing says so, in Chinese', async () => {
      await page.goto('/workbench?tab=approvals&approval=QUEUE-99999&approvalKind=design_result');
      const refused = page.getByRole('dialog', { name: zh.approvalOverlay.notAvailable.title });
      await expect(refused).toBeVisible();
      await expect(refused.getByText(zh.approvalOverlay.notAvailable.body)).toBeVisible();
    });
  });
});
