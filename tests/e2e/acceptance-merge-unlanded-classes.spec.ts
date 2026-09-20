import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { E2E_INSTALLATION_ID } from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import {
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import { adminDb } from '@/tests/helpers/adminDb';
import type { GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// ONE APPROVAL = ONE MERGE/ENQUEUE ACTION — THE ACCEPTANCE RECEIPT (Story MOTIR-5799 ·
// Subtask MOTIR-5808; `docs/decisions/approval-gates.md` § 4 FOURTH AMENDMENT;
// `design/github/approve-and-merge--ejected--reasked.mock.html` panels 1, 3 and 4).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person approves a green pull request. Whatever happens next, that yes is spent: it
// authorised ONE merge or enqueue and no more. So when the merge does not land, what the
// card offers is decided by the REASON, and the three ways it can go are the three
// journeys below.
//
//   1. RETRYABLE — the merge queue's checks failed. The card goes back to **In Review**
//      and asks ONE fresh question; the row's *Queue again* IS that approval, on the item
//      page and in the full-screen overlay alike, with `motir fix` beside it.
//   2. CAN'T LAND — a conflict. No approval, however fresh, can land those commits, so the
//      card drops to **Implemented**, NOTHING is asked, no verb is offered, and `motir fix`
//      is the only way forward. The card leaves the To-approve queue.
//   3. BLOCKED BY A SETTING — the host refused at the press because a branch protection
//      rule is in the way. The refusal is named on the spot; a reload shows the card back
//      at **In Review** with the setting on the row and *Retry merge* as the approval.
//      Satisfy the rule, press once, and it merges.
//
// ── THE SEAMS — all shipped, all reused ─────────────────────────────────────
//
//   * GitHub's merge and enqueue — `E2E_TEST_GITHUB_MERGE` (`lib/test-github-merge-mock.ts`).
//     Journeys 1 and 2 mark the repository as requiring a merge queue, so the press
//     ENQUEUES; journey 3 does not, so the press merges directly and can be refused.
//   * The queue's own deliveries — SIGNED `merge_group`, `pull_request` `dequeued` and
//     `check_run` bodies to the real `/api/github/webhook` route, from the REAL deliveries
//     MOTIR-5627 captured (`tests/fixtures/github/merge-queue/`). ⚠️ THE `MERGE_CONFLICT`
//     BODY IS DERIVED, NOT CAPTURED — `dequeued-ci-failure.json` with `reason` replaced, as
//     `acceptance-ejected-card-reads-red.spec.ts` explains at length.
//
// ⚠️ A WEBHOOK REACHES THE ITEM PAGE ON THE NEXT RENDER: the page has no live channel, so
// the spec RELOADS after each delivery, exactly as its two sibling receipts do. A PRESS
// repaints in place, and that is asserted without a reload.
//
// ⚠️ *QUEUE AGAIN* AND *RETRY MERGE* TAKE THE FRAME'S OWN CONFIRM (§ 28 panel 8a). The
// press IS a new approval, so it is asked for the way the frame's *Approve and merge* is —
// ONE band, over the verbs — and the band says aloud that this is a new approval and not
// the spent one. That sentence is the whole amendment, made visible.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response,
// or a rail's / row's text. The holds are `chapter()` / `beat()`'s, taken after assertions.
//
// ⚠️ THE 17xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 600_000 });

const PRS = {
  retryable: { number: 17101 },
  conflict: { number: 17201 },
  setting: { number: 17301 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;
const GROUP_SHA = '5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed';
const CHECK_URL = 'https://github.com/motir-projects-e2e/amerge-web/actions/runs/17/job/1';
/** The captured merge-group check's own name (`check-run-failed-merge-group.json`). */
const CHECK_NAME = 'Vitest (7/12)';
const pra = en.approvalGate.pullRequestApproval;
const fix = en.github.development.fix;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** The tags the rich messages use — removed by name, not by pattern. */
const RICH_TAGS = ['<b>', '</b>', '<code>', '</code>', '<link>', '</link>', '<prs></prs>'] as const;
const plain = (text: string) => RICH_TAGS.reduce((out, tag) => out.split(tag).join(''), text);

const prName = (number: number) => `${WEB} · #${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `unlanded/${card.identifier.toLowerCase()}-${number}`;
const installation = { id: Number(E2E_INSTALLATION_ID) };
const repository = { id: Number(WEB_REPO.providerRepoId) };

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

// ── The page ────────────────────────────────────────────────────────────────

const developmentCard = (page: Page, title = en.github.development.title): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

const prRow = (page: Page, number: number, title?: string): Locator =>
  developmentCard(page, title)
    .locator('li')
    .filter({ hasText: prName(number) });

const fixPart = (page: Page, label: string = fix.aria.part): Locator =>
  page.getByRole('group', { name: label });

const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** The card's row in the To-approve table, filtered by its own decide control — the
 *  sibling overlay receipt explains why the kind label alone is not enough. */
const toApproveRow = (page: Page, card: SeededCard): Locator =>
  page
    .getByRole('table', { name: en.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: card.identifier })
    .filter({
      has: page.getByRole('button', { name: en.workbench.approvals.review, exact: true }),
    });

/** The overlay, by its SETTLED accessible name — the name is composed from the read's own
 *  work item, so finding it IS the wait for the read. */
const overlayFor = (page: Page, card: SeededCard): Locator =>
  page.getByRole('dialog', {
    name: fill(en.approvalOverlay.dialogTitle, {
      kind: pra.kindLabel,
      key: card.identifier,
    }),
    exact: true,
  });

/** The authoritative read-back: how many questions the card holds right now. */
const awaitingGates = (card: SeededCard): Promise<number> =>
  adminDb.approvalGate.count({
    where: { workItemId: card.id, kind: 'pull_request_approval', state: 'awaiting' },
  });

/** Bring an element to the middle of the viewport, so the video shows what was asserted. */
async function show(target: Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

async function open(page: Page, card: SeededCard, title?: string): Promise<void> {
  await page.goto(`/items/${card.identifier}`);
  await expect(developmentCard(page, title)).toHaveCount(1, { timeout: 60_000 });
}

// ── The deliveries ──────────────────────────────────────────────────────────

async function deliver(page: Page, event: string, payload: unknown, what: string): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), `${what} → ${(await res.text()).slice(0, 300)}`).toBe(200);
}

/** Open one pull request, link it, and turn it green. */
async function deliverGreen(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  const { number } = PRS[scenario];
  const headRef = headRefFor(card, number);
  await deliver(
    page,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number,
      title: card.title,
      headRef,
      state: 'open',
      merged: false,
      repo: WEB_REPO,
    }),
    `open #${number}`,
  );
  await linkPr(page, { workItemId: card.id, repo: WEB_REPO, number, headRef });
  await deliver(
    page,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: headShaFor(number),
      prNumber: number,
      headBranch: headRef,
      repo: WEB_REPO,
    }),
    `green #${number}`,
  );
}

/** The queue starts testing a group that names `number` — the captured delivery. */
function checksRequested(number: number): Record<string, unknown> {
  const body = captured('merge-group-checks-requested');
  const group = body['merge_group'] as Record<string, unknown>;
  return {
    ...body,
    installation,
    repository,
    merge_group: {
      ...group,
      head_sha: GROUP_SHA,
      head_ref: `refs/heads/gh-readonly-queue/main/pr-${number}-${group['base_sha'] as string}`,
    },
  };
}

/** The queue removed `number`. `reason` is the captured one, or a DERIVED spelling. */
function dequeued(number: number, reason: string): Record<string, unknown> {
  const body = captured('dequeued-ci-failure');
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  return {
    ...body,
    reason,
    number,
    installation,
    repository,
    pull_request: {
      ...pr,
      number,
      head: { ...(pr['head'] as Record<string, unknown>), sha: headShaFor(number) },
    },
  };
}

/** The queue's check that failed on the group's commit — the captured check run. */
function failedGroupCheck(): Record<string, unknown> {
  const body = captured('check-run-failed-merge-group');
  return {
    ...body,
    installation,
    repository,
    check_run: {
      ...(body['check_run'] as Record<string, unknown>),
      head_sha: GROUP_SHA,
      html_url: CHECK_URL,
    },
  };
}

// ── The presses ─────────────────────────────────────────────────────────────

/** *Approve and merge*, with its confirm step — the verb that decides the whole set. */
async function pressApproveAndMerge(page: Page): Promise<void> {
  const dev = developmentCard(page);
  await dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
  const action = serverAction(page);
  await dev
    .getByRole('button', {
      name: fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
      exact: true,
    })
    .click();
  expect((await action).status()).toBe(200);
}

/** A ROW verb on the RE-ASKED gate: press, read the confirm, proceed. The press is the
 *  new approval, and the band is where it says so (§ 28 panel 8a). */
async function pressRowVerb(page: Page, number: number, verb: string): Promise<void> {
  const row = prRow(page, number);
  await show(row);
  await row.getByRole('button', { name: verb }).click();
  const dev = developmentCard(page);
  await expect(dev.getByText(/a new approval, not the spent one/)).toBeVisible();
  const action = serverAction(page);
  await dev
    .getByRole('button', { name: fill(en.approvalGate.confirm.proceed, { verb }), exact: true })
    .click();
  expect((await action).status()).toBe(200);
}

async function approvedIntoTheQueue(page: Page, card: SeededCard, scenario: Scenario) {
  await open(page, card);
  await pressApproveAndMerge(page);
  await expect(
    prRow(page, PRS[scenario].number).getByText(pra.outcome.queued, { exact: true }),
  ).toBeVisible();
  await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
}

test.describe('a merge that does not land, by reason class', () => {
  let seed: ApproveAndMergeSeed;
  let retryable: SeededCard;
  let conflict: SeededCard;
  let setting: SeededCard;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    retryable = seed.merged;
    conflict = seed.queued;
    setting = seed.refused;
    writeFileSync(JOURNAL_PATH, '');
    // The repository requires a merge queue: a press ENQUEUES. Journey 3 rewrites this.
    const control: GithubMergeControl = { repositories: [WEB], mergeQueueRepositories: [WEB] };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, retryable, 'retryable');
    await deliverGreen(page, conflict, 'conflict');
    await deliverGreen(page, setting, 'setting');
  });

  // ⚠️ ONE TEST, THREE JOURNEYS — not three tests. The card's plan said one `test()` per
  // journey with a video each, and `publish_acceptance_result` takes ONE recording: three
  // clips would mean two of them are not the receipt, and a reviewer approving the gate
  // would be approving one class out of three. So the three journeys are chapters of one
  // run, exactly as `acceptance-merge-queue-ejection.spec.ts` chapters its five.
  test('a merge that does not land is classed by its REASON, and the card offers only what that class allows', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5799');
    const number = PRS.retryable.number;

    await chapter('Approved and in the merge queue', async () => {
      await approvedIntoTheQueue(page, retryable, 'retryable');
      expect(await awaitingGates(retryable)).toBe(0);
      await beat();
      await show(prRow(page, number));
    });
    await beat();

    await chapter('Its checks fail in the queue: the card is asked AGAIN, once', async () => {
      await deliver(page, 'merge_group', checksRequested(number), 'the queue tests the group');
      await deliver(page, 'pull_request', dequeued(number, 'CI_FAILURE'), 'the queue removes it');
      await deliver(page, 'check_run', failedGroupCheck(), 'the failed check reports');
      await page.reload();

      // ⚠️ IN REVIEW, NOT IMPLEMENTED (§ 4 point 3). The approval was spent by the enqueue,
      // so the question comes back — and exactly one of it.
      await expect(statusCard(page)).toContainText('In Review', { timeout: 60_000 });
      expect(await awaitingGates(retryable)).toBe(1);
      const row = prRow(page, number);
      await expect(row.getByText(pra.outcome.leftQueue, { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: pra.outcome.queueAgain })).toBeVisible();
      await show(row);
      await beat();

      // The frame SAYS it is a re-ask, and the record band says why: the reason in words,
      // the failing check as a link, and that the earlier approval was SPENT (§ 28 panel 1).
      const dev = developmentCard(page);
      await expect(dev.getByText(/Asked again after the merge queue/)).toBeVisible();
      await expect(
        dev.getByText(
          plain(fill(pra.exit.left, { pr: prName(number), reason: pra.exit.reason.CI_FAILURE })),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        dev.getByRole('link', { name: fill(pra.exit.openCheck, { check: CHECK_NAME }) }),
      ).toHaveAttribute('href', CHECK_URL);
      const spent = dev.getByText(plain(pra.exit.reasked.failure), { exact: true });
      await expect(spent).toBeVisible();
      await show(spent);
      await beat();

      // `motir fix` sits beside it, and the sentence says which to reach for.
      const part = fixPart(page);
      await expect(part).toContainText(`${prName(number)} left the merge queue.`);
      await expect(part).toContainText(`motir fix ${retryable.identifier}`);
      await expect(part.getByText(plain(fix.which.checks), { exact: true })).toBeVisible();
      await show(part);
    });
    await beat();

    await chapter('The same question, full screen, from the To-approve queue', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = toApproveRow(page, retryable);
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      await row.getByRole('button', { name: en.workbench.approvals.review, exact: true }).click();

      const dialog = overlayFor(page, retryable);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      const overlayRow = dialog.locator('li').filter({ hasText: prName(number) });
      await expect(overlayRow.getByText(pra.outcome.leftQueue, { exact: true })).toBeVisible();
      await expect(overlayRow.getByRole('button', { name: pra.outcome.queueAgain })).toBeVisible();
      // ⚠️ `motir fix` REACHES THE OVERLAY TOO (MOTIR-5806): most of these decisions are
      // made here, and a way forward offered on only one of the two surfaces is a way
      // forward most people never see.
      await expect(dialog.getByRole('group', { name: fix.aria.part })).toContainText(
        `motir fix ${retryable.identifier}`,
      );
      await show(dialog.getByRole('group', { name: fix.aria.part }));
      await beat();
      await page.keyboard.press('Escape');
      await expect(overlayFor(page, retryable)).toHaveCount(0);
    });
    await beat();

    await chapter('One press of Queue again, and that press IS the new approval', async () => {
      await open(page, retryable);
      await pressRowVerb(page, number, pra.outcome.queueAgain);

      await expect(
        prRow(page, number).getByText(pra.outcome.queued, { exact: true }),
      ).toBeVisible();
      await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
      // The question it decided is gone — and no second one took its place.
      expect(await awaitingGates(retryable)).toBe(0);
      await expect(
        prRow(page, number).getByRole('button', { name: pra.outcome.queueAgain }),
      ).toHaveCount(0);
      await beat();
      await show(statusCard(page));
      await beat();

      await page.goto('/workbench?tab=approvals');
      await expect(page.getByRole('table', { name: en.workbench.tabs.toApprove })).toBeVisible({
        timeout: 60_000,
      });
      await expect(toApproveRow(page, retryable)).toHaveCount(0);
    });
    await beat();

    await chapter('The same ejection, in Chinese', async () => {
      const zpra = zh.approvalGate.pullRequestApproval;
      // A second genuine ejection of the same card, at the same head.
      await deliver(page, 'pull_request', dequeued(number, 'CI_FAILURE'), 'ejected again');
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      const title = zh.github.development.title;
      await open(page, retryable, title);
      const row = prRow(page, number, title);
      await expect(row.getByText(zpra.outcome.leftQueue, { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: zpra.outcome.queueAgain })).toBeVisible();
      expect(await awaitingGates(retryable)).toBe(1);
      await show(row);
      // ⚠️ PUT THE LOCALE BACK. The cookie outlives the chapter, and the two journeys
      // below read the ENGLISH surface — without this they open a page whose Development
      // heading is 开发, and the locator that waits for the block waits for ever.
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: new URL('/', page.url()).href }]);
    });
    await beat();

    // ── JOURNEY 2 · CAN'T LAND ──────────────────────────────────────────────────
    const conflictNumber = PRS.conflict.number;
    await chapter('A second card, approved and in the merge queue', async () => {
      await approvedIntoTheQueue(page, conflict, 'conflict');
      await beat();
      await show(prRow(page, conflictNumber));
    });
    await beat();

    await chapter(
      'It no longer merges cleanly: the card falls back, and nothing is asked',
      async () => {
        await deliver(
          page,
          'pull_request',
          dequeued(conflictNumber, 'MERGE_CONFLICT'),
          'a conflict',
        );
        await page.reload();

        // ⚠️ IMPLEMENTED, AND NO QUESTION (§ 4 point 2). No approval can land these commits,
        // so asking for one would be asking for a press guaranteed to fail.
        await expect(statusCard(page)).toContainText('Implemented', { timeout: 60_000 });
        expect(await awaitingGates(conflict)).toBe(0);
        const row = prRow(page, conflictNumber);
        await expect(row.getByText(pra.outcome.cannotLand, { exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: pra.outcome.queueAgain })).toHaveCount(0);
        await expect(row.getByRole('button', { name: pra.outcome.retry })).toHaveCount(0);
        await expect(
          developmentCard(page).getByRole('button', { name: pra.verb.approveAndMerge }),
        ).toHaveCount(0);
        await show(row);
        await beat();

        // The record still says WHY, because the row has no verb to say it for.
        await expect(
          developmentCard(page).getByText(plain(pra.exit.cannotLand), { exact: true }),
        ).toBeVisible();
        const part = fixPart(page);
        await expect(part).toContainText(`motir fix ${conflict.identifier}`);
        await expect(part.getByText(plain(fix.which.conflict), { exact: true })).toBeVisible();
        await show(part);
      },
    );
    await beat();

    await chapter('And it is not in anybody’s To-approve queue', async () => {
      await page.goto('/workbench?tab=approvals');
      await expect(page.getByRole('table', { name: en.workbench.tabs.toApprove })).toBeVisible({
        timeout: 60_000,
      });
      await expect(toApproveRow(page, conflict)).toHaveCount(0);
    });
    await beat();

    // ── JOURNEY 3 · BLOCKED BY A SETTING ────────────────────────────────────────
    const settingNumber = PRS.setting.number;
    const key = `${WEB}#${settingNumber}`;
    // ⚠️ NO MERGE QUEUE FOR THIS JOURNEY: the press merges DIRECTLY, which is the path the
    // host can refuse. A branch protection rule is in the way.
    const refuse: GithubMergeControl = {
      repositories: [WEB],
      pullRequests: { [key]: { outcome: 'refused', refusal: 'branch_protected' } },
    };
    writeFileSync(CONTROL_PATH, JSON.stringify(refuse));

    await chapter('Approve and merge — and GitHub says no', async () => {
      await open(page, setting);
      await pressApproveAndMerge(page);

      const alert = developmentCard(page).getByRole('alert');
      await expect(alert).toContainText(fill(pra.refused.title, { pr: prName(settingNumber) }));
      await expect(alert).toContainText(en.approvalGate.refusal.mergeBranchProtected.title);
      await show(alert);
      await beat();
    });
    await beat();

    await chapter(
      'A reload: the card is In Review again, and the row names the setting',
      async () => {
        await page.reload();

        // ⚠️ THE SETTING CLASS RE-ASKS (§ 4 point 5): somebody can change the rule, so the
        // question is worth asking again — with what is in the way said on the row.
        await expect(statusCard(page)).toContainText('In Review', { timeout: 60_000 });
        expect(await awaitingGates(setting)).toBe(1);
        const row = prRow(page, settingNumber);
        await expect(row.getByText(pra.outcome.settingHeld, { exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: pra.outcome.retry })).toBeVisible();
        await show(row);
        await beat();

        // The pill says the CLASS; the record band names the setting and says what to do
        // about it — including that `motir fix` is NOT the answer here (§ 28 panel 4).
        const dev = developmentCard(page);
        await expect(
          dev.getByText(plain(fill(pra.setting.line, { pr: prName(settingNumber) })), {
            exact: true,
          }),
        ).toBeVisible();
        await expect(dev.getByText(plain(pra.setting.reasked), { exact: true })).toBeVisible();
        await expect(fixPart(page)).toHaveCount(0);
        await show(dev.getByText(plain(pra.setting.reasked), { exact: true }));
        await beat();
      },
    );
    await beat();

    await chapter(
      'The rule is satisfied on GitHub; one press of Retry merge lands it',
      async () => {
        writeFileSync(CONTROL_PATH, JSON.stringify({ repositories: [WEB] }));
        await pressRowVerb(page, settingNumber, pra.outcome.retry);

        await expect(
          prRow(page, settingNumber).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
        await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
        // The press decided the question it was asked — and raised no other.
        expect(await awaitingGates(setting)).toBe(0);
        await expect(developmentCard(page).getByRole('alert')).toHaveCount(0);
        await beat();
        await show(statusCard(page));
      },
    );
    await beat();
  });
});
