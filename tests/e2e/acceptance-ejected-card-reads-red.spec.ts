import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { gotoLoadedBoard } from './_helpers/board';
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
import { apiTokensService } from '@/lib/services/apiTokensService';
import type { GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// AN EJECTED CARD READS RED — THE ACCEPTANCE RECEIPT (Story MOTIR-5628 · Subtask
// MOTIR-5723; `design/github/github--fix-callout--ejected.mock.html`, Panels X1–X5).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An approved card's pull request joins its merge queue, and the queue throws it out
// because a check failed ON THE QUEUE'S MERGE COMMIT — the pull request's own checks are
// still green. Before this story nothing but the card's own page said so. Now the card
// reads *Checks failing* on the board, the list and the Workbench; its page offers both
// *Queue again* and `motir fix`, with the sentence that says which to use; the repair
// can be claimed; and *Queue again* clears the red. Then the two cases most likely to go
// wrong unnoticed: a CONFLICT (a different sentence) and a deliberate MANUAL removal
// (nothing turns red at all). And it all reads in Chinese.
//
// ── THE SEAMS — all shipped, all reused ─────────────────────────────────────
//
//   * GitHub's enqueue — `E2E_TEST_GITHUB_MERGE`, with the repository marked as requiring
//     a merge queue, so every press ENQUEUES.
//   * The queue's deliveries — SIGNED `pull_request` `dequeued` and `check_run` bodies to
//     the real `/api/github/webhook` route, from the REAL deliveries MOTIR-5627 captured
//     (`tests/fixtures/github/merge-queue/`). ⚠️ THE `MERGE_CONFLICT` BODY IS DERIVED, NOT
//     CAPTURED: no real conflict delivery was captured, so it is `dequeued-ci-failure.json`
//     with `reason` set to `MERGE_CONFLICT` — the published webhook enum's spelling and the
//     one `lib/mergeQueue/queueExit.ts` maps. No fixture file claims otherwise.
//   * The repair claim — `POST /api/v1/work-items/{key}/repair` with the owner's own
//     project-bound token: the request `motir fix` makes. The CLI binary is not run in a
//     browser lane; its loop is the story's vitest gate (MOTIR-5722).
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's response, a server action's response, the
// claim's body, or a badge's / row's text. The page has no live channel, so after each
// webhook the spec RELOADS, as `acceptance-merge-queue-ejection.spec.ts` does.
//
// ⚠️ THE 15xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 600_000 });

const PRS = {
  ejected: { number: 15101 },
  conflict: { number: 15201 },
  manual: { number: 15301 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;
const GROUP_SHA = '5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed';
const CHECK_URL = 'https://github.com/motir-projects-e2e/amerge-web/actions/runs/15/job/1';
const pra = en.approvalGate.pullRequestApproval;
const fix = en.github.development.fix;

/** The tags the fix part's rich messages use — removed by name, not by pattern. */
const RICH_TAGS = ['<b>', '</b>', '<code>', '</code>', '<prs></prs>'] as const;
const plain = (text: string) => RICH_TAGS.reduce((out, tag) => out.split(tag).join(''), text);

const prName = (number: number) => `${WEB} · #${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `ejected/${card.identifier.toLowerCase()}-${number}`;
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

// Rooted at `getByRole`, never at a test id (`tests/e2e-page-rooted-locators.test.ts`).
/** The card itself, by `boards.openIssueAria` ("Open {key}: {title}" / "打开 {key}：{title}"):
 *  the key followed by a colon, so the card's own "Actions for {key}" menu button is not
 *  also matched. */
const boardCard = (page: Page, card: SeededCard) =>
  page.getByRole('button', { name: new RegExp(`${card.identifier}[:：]`) });
const boardBadge = (page: Page, card: SeededCard) =>
  boardCard(page, card).locator('[data-ci-state="failing"]');
const itemRow = (page: Page, card: SeededCard) =>
  page.getByRole('row').filter({ hasText: card.identifier });
const rowBadge = (page: Page, card: SeededCard) =>
  itemRow(page, card).locator('[data-ci-state="failing"]');

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

/** `reason` is the captured one, or a DERIVED spelling (see the header). */
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

async function pressApproveAndMerge(page: Page): Promise<void> {
  const dev = developmentCard(page);
  await dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
  const action = serverAction(page);
  await dev
    .getByRole('button', {
      name: en.approvalGate.confirm.proceed.replace('{verb}', pra.verb.approveAndMerge),
      exact: true,
    })
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

// ── The claim `motir fix` makes ─────────────────────────────────────────────

interface ClaimBody {
  outcome: string;
  runId: string | null;
  pullRequests: Array<{
    number: number;
    queueExit: { rawReason: string; failingCheckUrl: string | null } | null;
  }>;
}

async function ownerApi(
  playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } },
  baseURL: string,
  seed: ApproveAndMergeSeed,
): Promise<APIRequestContext> {
  const owner = await adminDb.user.findUniqueOrThrow({ where: { email: seed.ownerEmail } });
  const { token } = await apiTokensService.create(owner.id, seed.workspaceId, {
    label: 'ejected-red-owner',
    projectId: seed.projectId,
    permissions: ['project:browse', 'work_item:edit'],
  });
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe('an ejected card reads red', () => {
  let seed: ApproveAndMergeSeed;
  let ejected: SeededCard;
  let conflict: SeededCard;
  let manual: SeededCard;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    ejected = seed.merged;
    conflict = seed.queued;
    manual = seed.refused;
    writeFileSync(JOURNAL_PATH, '');
    const control: GithubMergeControl = { repositories: [WEB], mergeQueueRepositories: [WEB] };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, ejected, 'ejected');
    await deliverGreen(page, conflict, 'conflict');
    await deliverGreen(page, manual, 'manual');
  });

  test('the queue throws it out: red everywhere, both ways forward on the page, and Queue again clears it', async ({
    page,
    playwright,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5628');
    const number = PRS.ejected.number;

    await chapter('Approved and in the merge queue — then the queue throws it out', async () => {
      await approvedIntoTheQueue(page, ejected, 'ejected');
      await beat();
      await deliver(page, 'merge_group', checksRequested(number), 'the queue tests the group');
      await deliver(page, 'pull_request', dequeued(number, 'CI_FAILURE'), 'the queue removes it');
      await deliver(page, 'check_run', failedGroupCheck(), 'the failed check reports');
      await page.reload();
      // ⚠️ THE RAIL ASSERTION WAS REMOVED, NOT UPDATED (Story MOTIR-5799 · MOTIR-5808;
      // § 4 FOURTH AMENDMENT, point 3). It read `Implemented`, which was true when
      // MOTIR-5628 was accepted; a retryable exit now returns the card to In Review and
      // asks once more. Re-pointing a receipt's assertion at today's behaviour would edit
      // history (`docs/decisions/acceptance-receipt-lifecycle.md` § 3), and this chapter's
      // subject — that the queue threw it out — does not need the rail to say so. The rail
      // is asserted for every class in
      // `tests/e2e/acceptance-merge-unlanded-classes.spec.ts`.
      await expect(
        prRow(page, number).getByText(pra.outcome.leftQueue, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await show(prRow(page, number));
    });
    await beat();

    await chapter('The board shows it: Checks failing', async () => {
      await gotoLoadedBoard(page);
      await expect(boardBadge(page, ejected)).toContainText(en.github.development.ciState.failing);
      await show(boardCard(page, ejected));
      await beat();
    });

    await chapter('So do the list and the Workbench', async () => {
      await page.goto('/items?view=list');
      await expect(rowBadge(page, ejected)).toHaveAttribute('aria-label', 'Checks failing');
      await show(itemRow(page, ejected));
      await beat();
      await page.goto('/workbench?tab=in-progress');
      await expect(rowBadge(page, ejected)).toHaveAttribute('aria-label', 'Checks failing');
      await show(itemRow(page, ejected));
      await beat();
    });

    await chapter('The card offers Queue again AND motir fix, and says which to use', async () => {
      await open(page, ejected);
      const row = prRow(page, number);
      await expect(row.getByText(pra.outcome.leftQueue, { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: pra.outcome.queueAgain })).toBeVisible();
      const part = fixPart(page);
      await expect(part).toContainText(`${prName(number)} left the merge queue.`);
      await expect(part).toContainText(`motir fix ${ejected.identifier}`);
      await expect(part.getByText(plain(fix.which.checks), { exact: true })).toBeVisible();
      await show(part);
      await beat();
    });
    await beat();

    await chapter('motir fix claims it — and the page shows who is fixing it', async () => {
      const api = await ownerApi(playwright, baseURL!, seed);
      const res = await api.post(`/api/v1/work-items/${ejected.identifier}/repair`);
      const text = await res.text();
      expect(res.status(), text.slice(0, 300)).toBe(200);
      const claim = JSON.parse(text) as ClaimBody;
      expect(claim.outcome).toBe('claimed');
      expect(claim.pullRequests[0]?.queueExit).toMatchObject({
        rawReason: 'CI_FAILURE',
        failingCheckUrl: CHECK_URL,
      });

      await page.reload();
      const part = fixPart(page);
      await expect(part).toContainText(fix.fixing.pill);
      // The viewer IS the holder — the claim was made with their own token — so the
      // part says "you" (`fixing.byYou`).
      await expect(part).toContainText('Being fixed by you');
      // Nothing to choose while an agent holds the repair (X4) — and Queue again stays.
      await expect(part.getByText(plain(fix.which.checks), { exact: true })).toHaveCount(0);
      await expect(
        prRow(page, number).getByRole('button', { name: pra.outcome.queueAgain }),
      ).toBeVisible();
      await show(part);
      await beat();

      const closed = await api.post(`/api/v1/dispatch-runs/${claim.runId}/close`, {
        data: { stopReason: 'halted' },
      });
      expect(closed.status(), await closed.text()).toBe(200);
      await api.dispose();
    });
    await beat();

    await chapter('Queue again: back in the queue, and the red is gone', async () => {
      await page.reload();
      const row = prRow(page, number);
      await show(row);
      const action = serverAction(page);
      await row.getByRole('button', { name: pra.outcome.queueAgain }).click();
      expect((await action).status()).toBe(200);
      await expect(row.getByText(pra.outcome.queued, { exact: true })).toBeVisible();
      await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
      await beat();
      await gotoLoadedBoard(page);
      await expect(boardCard(page, ejected)).toBeVisible();
      await expect(boardBadge(page, ejected)).toHaveCount(0);
      await show(boardCard(page, ejected));
    });
    await beat();

    await chapter('A conflict: only new commits fix it, and the card says so', async () => {
      const n = PRS.conflict.number;
      await approvedIntoTheQueue(page, conflict, 'conflict');
      await deliver(page, 'pull_request', dequeued(n, 'MERGE_CONFLICT'), 'a conflict removes it');
      await page.reload();
      await expect(statusCard(page)).toContainText('Implemented', { timeout: 60_000 });
      const part = fixPart(page);
      await expect(part.getByText(plain(fix.which.conflict), { exact: true })).toBeVisible();
      // ⚠️ THE *QUEUE AGAIN* ASSERTION WAS REMOVED, NOT INVERTED (MOTIR-5808; § 4 point 2).
      // A conflict is CAN'T LAND: no approval can land those commits, so the row offers no
      // verb at all now. That absence is asserted where it belongs — on the new receipt,
      // `acceptance-merge-unlanded-classes.spec.ts` journey 2 — rather than by rewriting
      // what this receipt's reviewer watched.
      await show(part);
      await beat();
      await gotoLoadedBoard(page);
      await expect(boardBadge(page, conflict)).toContainText(en.github.development.ciState.failing);
    });
    await beat();

    await chapter('Someone took it out on purpose: nothing turns red', async () => {
      const n = PRS.manual.number;
      await approvedIntoTheQueue(page, manual, 'manual');
      await deliver(page, 'pull_request', dequeued(n, 'MANUAL'), 'someone removes it');
      await page.reload();
      await expect(
        prRow(page, n).getByText(pra.outcome.removedFromQueue, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(fixPart(page)).toHaveCount(0);
      await show(prRow(page, n));
      await beat();
      await gotoLoadedBoard(page);
      await expect(boardCard(page, manual)).toBeVisible();
      await expect(boardBadge(page, manual)).toHaveCount(0);
      await page.goto('/items?view=list');
      await expect(itemRow(page, manual)).toBeVisible();
      await expect(rowBadge(page, manual)).toHaveCount(0);
    });
    await beat();

    await chapter('The same, in Chinese', async () => {
      const zfix = zh.github.development.fix;
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await gotoLoadedBoard(page);
      await expect(boardBadge(page, conflict)).toContainText(zh.github.development.ciState.failing);
      await beat();
      await open(page, conflict, zh.github.development.title);
      const part = fixPart(page, zfix.aria.part);
      await expect(part).toContainText(`${prName(PRS.conflict.number)} 已离开合并队列。`);
      await expect(part.getByText(plain(zfix.which.conflict), { exact: true })).toBeVisible();
      // The same removal as the English chapter above: a conflict offers no verb (§ 4
      // point 2), and the new receipt asserts that in both locales.
      await show(part);
    });
    await beat();
  });
});
