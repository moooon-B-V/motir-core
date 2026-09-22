import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import { openAgentSession, publishDesignResult } from './_helpers/design-approval-seed';
import { approvalSentence } from './_helpers/approval-sentence';
import {
  ACCEPTANCE_TITLE,
  FINISHED_PRS,
  FINISHED_TITLE,
  HIDDEN_TITLE,
  REPO_OWNER,
  seedPlainWordsApprovals,
  type PlainWordsSeed,
} from './_helpers/plain-words-approvals-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// TO APPROVE SAYS WHAT IS WAITING IN PLAIN WORDS — END TO END, AND THE ACCEPTANCE
// RECEIPT FOR IT (Story MOTIR-5996 · Subtask MOTIR-6003).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person with thirty approvals waiting opens To approve and:
//
//   1. sees ALL THIRTY on one page — no pager — each one a sentence about a work
//      item ("Design for X", "Acceptance video for story X", "X is finished"),
//      with no "pull request" anywhere; the repository and number are one hover
//      away, not in the text;
//   2. clicks a TITLE and gets that work item's quick view, over the list, without
//      opening the approval — and clicks the rest of the row and gets the approval;
//   3. inside the full-screen approval, clicks the title in its top bar and gets
//      the quick view STACKED ABOVE it; Esc closes only the quick view;
//   4. presses "Open work item" and gets a NEW TAB, while the approval stays open
//      in the first one.
//
// ── WHAT ONLY A BROWSER CAN PROVE ───────────────────────────────────────────
//
// Two dialogs stacking in the right order (asserted by hit-testing the quick
// view's centre, not by reading a z-index), Esc reaching only the top one, and a
// real second page opening while the first keeps its state. The sentences, the
// totality over every kind and the host-vocabulary guard are proven one tier down
// (`tests/integration/approvals/plain-words-story-gate.test.tsx`); here they are
// what the reviewer reads on screen.
//
// ⚠️ WHAT IS REAL AND WHAT IS SEEDED: `plain-words-approvals-seed.ts`'s header. The
// design gate is published for real over `/api/mcp`; the choice and decision gates
// are raised by `createWorkItem` itself; the acceptance and approve-to-merge gates
// are written directly, and the spec asserts only their SENTENCES and details.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — a named dialog, a row count, the URL, a hit test.
// `beat()` / `chapter()` hold the frame for a human AFTER each signal and never
// stand in for one.

test.describe.configure({ timeout: 300_000 });

const TOTAL = 30;

/** The To-approve table, named for its tab — the live subtree the rows belong to. */
const queue = (page: Page, name: string = en.workbench.tabs.toApprove) =>
  page.getByRole('table', { name });
const rowsIn = (table: Locator) => table.getByTestId(/^approval-row-/);
const rowFor = (table: Locator, title: string) => rowsIn(table).filter({ hasText: title });

/** The strip's To-approve badge, as a number — a suppressed zero is zero. */
async function badgeCount(page: Page, tab: RegExp): Promise<number> {
  const text = (await page.getByRole('link', { name: tab }).textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** The work item's title inside a row's sentence — the quick-view door. */
const titleDoor = (row: Locator, title: string) =>
  row.getByRole('link', { name: title, exact: true });

/** The rest of the row — the approval door, clicked at its left edge, on the
 *  sentence's frame words ("Design for"), clear of the title link above it. */
async function openApproval(row: Locator): Promise<void> {
  await row.getByRole('link', { name: /^(Review|查看) / }).click({ position: { x: 8, y: 22 } });
}

const quickView = (page: Page, key: string) =>
  page.getByRole('dialog', { name: en.issueViews.quickViewDialogLabel.replace('{key}', key) });

/** Whether the element at the centre of `dialog` belongs to it — "on top", by a hit test. */
async function isTopmost(dialog: Locator): Promise<boolean> {
  return dialog.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && node.contains(hit);
  });
}

/** A git host's vocabulary, in both locales — never in the list's visible text. */
const HOST_VOCABULARY = /pull request|\bPR\b|merge request|#\d+|拉取请求|合并请求/i;

test.describe('To approve, in plain words', () => {
  let seed: PlainWordsSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedPlainWordsApprovals(`pw${Date.now().toString(36)}`);
  });

  test('thirty approvals read as sentences on one page, a title peeks, and the approval keeps you in place', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5996');
    await servePrivateObjectStore(page);

    const client = await openAgentSession(seed.token, baseURL!);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    await client.close();

    const table = queue(page);
    const designRow = rowFor(table, seed.designTitle);
    const approval = page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });
    const designPeek = quickView(page, seed.designKey);

    await chapter('Thirty approvals are waiting, all of them on one page', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto('/workbench?tab=approvals');
      await expect(rowsIn(table)).toHaveCount(TOTAL);
      expect(await badgeCount(page, /To approve/)).toBe(TOTAL);
      // No pager, and no ceiling line: thirty is far under the stated ceiling.
      await expect(page.getByRole('button', { name: 'Page 2' })).toHaveCount(0);
      await expect(page.getByRole('main').getByText(/^Showing the first /)).toHaveCount(0);
      // The work item the reviewer may not see is never in the list.
      await expect(rowFor(table, HIDDEN_TITLE)).toHaveCount(0);
    });
    await beat();

    await chapter('Each one says what is waiting, in plain words', async () => {
      await expect(designRow).toContainText(
        approvalSentence(en, 'design_result', seed.designTitle),
      );
      await expect(rowFor(table, ACCEPTANCE_TITLE)).toContainText(
        approvalSentence(en, 'acceptance_result', ACCEPTANCE_TITLE),
      );
      const finished = rowFor(table, FINISHED_TITLE);
      await expect(finished).toContainText(
        approvalSentence(en, 'pull_request_approval', FINISHED_TITLE),
      );
      // The whole list, as read: no git host's words anywhere in it.
      expect(await table.innerText()).not.toMatch(HOST_VOCABULARY);

      // The repositories are in the text; their numbers are one hover away.
      const set = finished.getByText(
        en.workbench.approvals.pullRequest.repos.replace(
          '{repos}',
          FINISHED_PRS.map((pr) => pr.name).join(en.workbench.approvals.pullRequest.separator),
        ),
      );
      await expect(set).toHaveAttribute(
        'title',
        FINISHED_PRS.map((pr) => `${REPO_OWNER}/${pr.name} · #${pr.number}`).join(', '),
      );
      await set.hover();
    });
    await beat();

    await chapter('A title opens the work item’s quick view, over the list', async () => {
      await titleDoor(designRow, seed.designTitle).click();
      await expect(designPeek).toBeVisible();
      await expect(designPeek.getByText(seed.designTitle).first()).toBeVisible();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === '/workbench' &&
          url.searchParams.get('peek') === seed.designKey &&
          url.searchParams.get('approval') === null,
      );
      await expect(approval).toHaveCount(0);
    });
    await beat();

    await chapter('Closing it leaves the list exactly as it was', async () => {
      await page.keyboard.press('Escape');
      await expect(designPeek).toBeHidden();
      await expect(page).toHaveURL(
        (url) => url.pathname === '/workbench' && url.searchParams.get('peek') === null,
      );
      await expect(rowsIn(table)).toHaveCount(TOTAL);
    });
    await beat();

    await chapter('The rest of the row opens the approval, full screen', async () => {
      await openApproval(designRow);
      await expect(approval).toBeVisible();
      await expect(page).toHaveURL(
        (url) =>
          url.searchParams.get('approval') === seed.designKey &&
          url.searchParams.get('peek') === null,
      );
      await expect(approval.getByRole('group', { name: en.approvalGate.port.label })).toBeVisible();
    });
    await beat();

    const approvalAddress = page.url();

    await chapter('Its title opens the quick view ABOVE the approval', async () => {
      // The exit row's key-and-title link; `(?!\d)` so QUEUE-2 never matches QUEUE-20.
      await approval.getByRole('link', { name: new RegExp(`^${seed.designKey}(?!\\d)`) }).click();
      await expect(designPeek).toBeVisible();
      expect(await isTopmost(designPeek)).toBe(true);
      // The approval is still the address underneath — the peek is not a navigation.
      expect(page.url()).toBe(approvalAddress);
    });
    await beat();

    await chapter('Esc closes only the quick view; the approval is still open', async () => {
      await page.keyboard.press('Escape');
      await expect(designPeek).toBeHidden();
      await expect(approval).toBeVisible();
      expect(page.url()).toBe(approvalAddress);
    });
    await beat();

    await chapter('Open work item opens a new tab, and this one keeps the approval', async () => {
      const opened = page.context().waitForEvent('page');
      await approval.getByRole('link', { name: en.approvalOverlay.openWorkItemNewTab }).click();
      const tab = await opened;
      await tab.waitForURL((url) => url.pathname === `/items/${seed.designKey}`);
      await expect(tab.getByRole('heading', { name: seed.designTitle }).first()).toBeVisible();
      await tab.close();

      await page.bringToFront();
      await expect(approval).toBeVisible();
      expect(page.url()).toBe(approvalAddress);
    });
    await beat();

    await chapter('Esc again closes the approval, back on the list', async () => {
      await page.keyboard.press('Escape');
      await expect(approval).toBeHidden();
      await expect(page).toHaveURL(
        (url) => url.pathname === '/workbench' && url.search === '?tab=approvals',
      );
      await expect(rowsIn(table)).toHaveCount(TOTAL);
    });
    await beat();

    await chapter(
      'Approval records reads the same sentences, and a title peeks there too',
      async () => {
        await page
          .getByRole('navigation', { name: 'Primary' })
          .getByRole('link', { name: 'Approval records', exact: true })
          .click();
        await expect(page).toHaveURL((url) => url.pathname === '/approvals');
        const room = page.getByRole('table', { name: 'Approval records' });
        // The room lists OLDEST first, so its first row is the first choice — the same
        // one-row component, another kind's sentence. (The room's own paging is its
        // specs', not this one's.)
        const roomRow = rowFor(room, seed.firstChoiceTitle);
        await expect(roomRow).toContainText(
          approvalSentence(en, 'decision_choice', seed.firstChoiceTitle),
        );
        expect(await room.innerText()).not.toMatch(HOST_VOCABULARY);

        const choicePeek = quickView(page, seed.firstChoiceKey);
        await titleDoor(roomRow, seed.firstChoiceTitle).click();
        await expect(choicePeek).toBeVisible();
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === '/approvals' && url.searchParams.get('peek') === seed.firstChoiceKey,
        );
        // …and not the approval: the title is the quick-view door, not the row's.
        await expect(
          page.getByRole('dialog', {
            name: `${en.workbench.approvals.kind.decision_choice} for ${seed.firstChoiceKey}`,
          }),
        ).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(choicePeek).toBeHidden();
      },
    );
    await beat();

    await chapter('A work item you may not see opens as not available', async () => {
      await page.goto(`/workbench?tab=approvals&peek=${seed.hiddenKey}`);
      const hidden = quickView(page, seed.hiddenKey);
      await expect(hidden).toBeVisible();
      await expect(hidden.getByText(en.issueViews.quickViewUnavailableTitle)).toBeVisible();
      await expect(hidden.getByText(HIDDEN_TITLE)).toHaveCount(0);
    });
  });

  test('the sentences in Chinese', async ({ page, baseURL, acceptanceStory }) => {
    acceptanceStory('MOTIR-5996');
    await servePrivateObjectStore(page);
    const client = await openAgentSession(seed.token, baseURL!);
    expect((await publishDesignResult(client, seed.designKey)).isError ?? false).toBe(false);
    await client.close();

    await signIn(page, seed.reviewerEmail, seed.password);
    // The suite's own locale switch (`workbench.spec.ts`).
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).toString() }]);
    await page.goto('/workbench?tab=approvals');

    const table = queue(page, zh.workbench.tabs.toApprove);
    await expect(rowsIn(table)).toHaveCount(TOTAL);
    await expect(rowFor(table, seed.designTitle)).toContainText(
      approvalSentence(zh, 'design_result', seed.designTitle),
    );
    await expect(rowFor(table, ACCEPTANCE_TITLE)).toContainText(
      approvalSentence(zh, 'acceptance_result', ACCEPTANCE_TITLE),
    );
    await expect(rowFor(table, FINISHED_TITLE)).toContainText(
      approvalSentence(zh, 'pull_request_approval', FINISHED_TITLE),
    );
    expect(await table.innerText()).not.toMatch(HOST_VOCABULARY);
    // Negatively too: the English frame is not reachable on a `zh` page.
    await expect(table.getByText('Design for', { exact: false })).toHaveCount(0);

    // The title door is the same door in either language.
    await titleDoor(rowFor(table, seed.designTitle), seed.designTitle).click();
    await expect(
      page.getByRole('dialog', {
        name: zh.issueViews.quickViewDialogLabel.replace('{key}', seed.designKey),
      }),
    ).toBeVisible();
  });
});
