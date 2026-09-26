import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import { actionWrite } from './_helpers/authoritative-signal';
import { openAgentSession, publishDesignResult } from './_helpers/design-approval-seed';
import {
  FINISHED_TITLE,
  seedPlainWordsApprovals,
  type PlainWordsSeed,
} from './_helpers/plain-words-approvals-seed';
import en from '@/messages/en.json';

// ACCEPTANCE — A REFUSAL SAYS WHY (Story MOTIR-6067 · Subtask MOTIR-6077; ADR
// `approval-gates.md` §10a; design `approval-control--refusal-reason.mock.html` and the
// row deltas). The story's own `## Verification`, driven: a reviewer sends back a design,
// a choice and a set of pull requests, each WITH a reason — is refused when they try to
// send one empty, loses nothing when a send fails in transit — and reads every reason
// back where the decision is recorded: the overlay, the item page, the Approvals room.
//
// ⚠️ EVERY WAIT IS AN AUTHORITATIVE SIGNAL: the server action's own response (armed
// before the press), or the decided record's own element — never a timeout.

test.describe.configure({ timeout: 300_000 });

const r = en.approvalGate.reason;
const kind = en.workbench.approvals.kind;

const DESIGN_REASON = 'The empty state needs the illustration, not a line of text.';
const CHOICE_REASON = 'We need the files in our own bucket — none of these offers that.';
const PR_REASON = [
  'The retry loop never backs off, so a flaky endpoint is hammered until the job times out.',
  'Add a ceiling and an exponential delay, and log the attempt count on the final failure.',
  'The migration also drops a column the importer still reads — split it from the backfill so the importer ships first.',
  'Keep the rest: the tests are the right ones and the naming matches the rest of the module.',
].join(' ');

const queue = (page: Page) => page.getByRole('table', { name: en.workbench.tabs.toApprove });
const rowFor = (table: Locator, title: string) =>
  table.getByTestId(/^approval-row-/).filter({ hasText: title });

/** The row's approval door, clicked on the sentence's frame words, clear of the title link. */
async function openApproval(row: Locator): Promise<void> {
  await row.getByRole('link', { name: /^Review / }).click({ position: { x: 8, y: 22 } });
}

/** Press a refusal, write its reason at a pace a reviewer can read, and send it. */
async function refuse(
  page: Page,
  dialog: Locator,
  words: { verb: string; label: string; proceed: string },
  reason: string,
): Promise<void> {
  await dialog.getByRole('button', { name: words.verb, exact: true }).click();
  await dialog.getByLabel(words.label).pressSequentially(reason, { delay: 12 });
  const written = actionWrite(page, '/workbench', reason.slice(0, 24));
  await dialog.getByRole('button', { name: words.proceed, exact: true }).click();
  expect((await written).status()).toBe(200);
}

test.describe('A refusal says why', () => {
  let seed: PlainWordsSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedPlainWordsApprovals(`rr${Date.now().toString(36)}`);
  });

  test('a design, a choice and a set of pull requests are sent back WITH a reason, and every record quotes it', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6067');
    await servePrivateObjectStore(page);

    const client = await openAgentSession(seed.token, baseURL!);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    await client.close();

    const designDialog = page.getByRole('dialog', {
      name: `${kind.design_result} for ${seed.designKey}`,
    });

    await chapter(
      'Request changes on a design ASKS WHY — and an empty reason is refused',
      async () => {
        await signIn(page, seed.reviewerEmail, seed.password);
        await page.goto('/workbench?tab=approvals');
        await openApproval(rowFor(queue(page), seed.designTitle));
        await expect(designDialog).toBeVisible();

        await designDialog
          .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
          .click();
        await expect(designDialog.getByText(r.title)).toBeVisible();
        await expect(designDialog.getByLabel(r.label)).toBeVisible();
        await expect(designDialog.getByText(r.helper)).toBeVisible();

        // Sent EMPTY: refused in place, and nothing reached the door — still awaiting.
        await designDialog.getByRole('button', { name: r.proceed, exact: true }).click();
        await expect(designDialog.getByText(r.required)).toBeVisible();
        await expect(
          designDialog.getByText(en.approvalGate.state.awaitingYou, { exact: true }),
        ).toBeVisible();
      },
    );
    await beat();

    await chapter(
      'A send that fails is shown in place, and the reason survives the retry',
      async () => {
        await designDialog.getByLabel(r.label).pressSequentially(DESIGN_REASON, { delay: 12 });
        // A DESIGN sent back also names its VERDICT (MOTIR-6070 · MOTIR-6427): the door
        // refuses a design refusal without one. Revise asks nothing afterwards, so the
        // record below is the whole answer, as it was when this receipt was recorded.
        // The radio is `sr-only` inside its tile's <label>, which receives the pointer.
        const verdicts = designDialog.getByRole('radiogroup', { name: r.verdict.legend });
        await verdicts.locator('label[data-verdict="revise"]').click();
        await expect(
          verdicts.getByRole('radio', { name: new RegExp(`^${r.verdict.revise.label}`) }),
        ).toBeChecked();
        // ONE injected failure on the decide call — the server action's POST.
        let failed = false;
        await page.route('**/workbench**', async (route) => {
          const req = route.request();
          if (!failed && req.method() === 'POST' && req.headers()['next-action']) {
            failed = true;
            await route.fulfill({ status: 500, body: 'injected failure' });
            return;
          }
          await route.fallback();
        });
        await designDialog.getByRole('button', { name: r.proceed, exact: true }).click();
        await expect(
          designDialog.getByText(en.approvalGate.refusal.unexpected.title),
        ).toBeVisible();
        await page.unroute('**/workbench**');

        // The retry: the verb is live again, and the band reopens with what was written.
        await designDialog
          .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
          .click();
        await expect(designDialog.getByLabel(r.label)).toHaveValue(DESIGN_REASON);
        const written = actionWrite(page, '/workbench', DESIGN_REASON.slice(0, 24));
        await designDialog.getByRole('button', { name: r.proceed, exact: true }).click();
        expect((await written).status()).toBe(200);

        // The decided record QUOTES it.
        await expect(designDialog.getByText(`“${DESIGN_REASON}”`)).toBeVisible();
        await expect(
          designDialog.getByText(en.approvalGate.state.changesRequested, { exact: true }),
        ).toBeVisible();
      },
    );
    await beat();

    await chapter('The card’s own design section quotes the same reason', async () => {
      await page.keyboard.press('Escape');
      await expect(designDialog).toBeHidden();
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('main').getByText(`“${DESIGN_REASON}”`)).toBeVisible();
    });
    await beat();

    await chapter('None of these on a choice asks why, too', async () => {
      await page.goto('/workbench?tab=approvals');
      await openApproval(rowFor(queue(page), seed.firstChoiceTitle));
      const choiceDialog = page.getByRole('dialog', {
        name: `${kind.decision_choice} for ${seed.firstChoiceKey}`,
      });
      await expect(choiceDialog).toBeVisible();
      await refuse(
        page,
        choiceDialog,
        {
          verb: en.approvalGate.choice.verb.noneOfThese,
          label: r.choice.label,
          proceed: r.choice.proceed,
        },
        CHOICE_REASON,
      );
      await expect(choiceDialog.getByText(`“${CHOICE_REASON}”`)).toBeVisible();
      // MOTIR-6068 (MOTIR-6211): a None of these now OFFERS the seeded planner in the
      // decided band. Declining it opens nothing and leaves the overlay open, so answer
      // it before closing — that receipt is MOTIR-6068's, not this story's.
      await choiceDialog
        .getByRole('button', { name: en.planningWorkspace.handoff.notNow, exact: true })
        .click();
      await page.keyboard.press('Escape');
      await expect(choiceDialog).toBeHidden();
    });
    await beat();

    await chapter(
      'Pull requests sent back with a long reason — clamped, then shown in full',
      async () => {
        await openApproval(rowFor(queue(page), FINISHED_TITLE));
        const prDialog = page.getByRole('dialog', {
          // The Development frame names itself by its own kind label ("Pull requests").
          name: `${en.approvalGate.pullRequestApproval.kindLabel} for ${seed.finishedKey}`,
        });
        await expect(prDialog).toBeVisible();
        await refuse(
          page,
          prDialog,
          { verb: en.approvalGate.verb.requestChanges, label: r.label, proceed: r.proceed },
          PR_REASON,
        );
        const showAll = prDialog.getByRole('button', { name: r.record.showAll, exact: true });
        await expect(showAll).toBeVisible();
        await expect(prDialog.getByText(`“${PR_REASON}”`)).toHaveClass(/line-clamp-3/);
        await showAll.click();
        await expect(prDialog.getByText(`“${PR_REASON}”`)).not.toHaveClass(/line-clamp-3/);
        await page.keyboard.press('Escape');
        await expect(prDialog).toBeHidden();
      },
    );
    await beat();

    await chapter('The Approvals room: every refusal carries its reason’s first line', async () => {
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'Approval records', exact: true })
        .click();
      await expect(page).toHaveURL((url) => url.pathname === '/approvals');
      // The room lists what is still waiting first; the decided half follows it, on the
      // next page with this seed's twenty-seven waiting rows.
      await page.getByRole('button', { name: 'Next page' }).click();
      const decided = page.getByRole('main').getByTestId('approval-records-decided');
      await expect(decided).toBeVisible();
      for (const [title, first] of [
        [seed.designTitle, DESIGN_REASON],
        [seed.firstChoiceTitle, CHOICE_REASON],
        [FINISHED_TITLE, PR_REASON],
      ] as const) {
        const row = decided.getByTestId(/^approval-row-/).filter({ hasText: title });
        await expect(row.getByTestId('refusal-reason-cell')).toHaveText(`“${first}”`);
      }
    });
    await beat();
  });
});
