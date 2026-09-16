import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { E2E_GITHUB_USER, E2E_INSTALLATION_ID } from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import {
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import { adminDb } from '@/tests/helpers/adminDb';
import type { GithubMergeCall, GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A PULL REQUEST THE MERGE QUEUE EJECTS — THE ACCEPTANCE RECEIPT (Story MOTIR-5461 ·
// Subtask MOTIR-5637; `design/github/approve-and-merge--ejected.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person approves a green pull request and it joins its merge queue: the card is
// Approved. The queue throws it out because a check failed. The card goes back to
// Implemented, and the row says so honestly — *Left the queue*, the reason in words, and
// the failing check, linked. The approval still stands, so ONE press of *Queue again* puts
// it back with no new question and the card is Approved again. Then the other branches:
// new commits after an ejection bring back exactly one fresh question, a neutral removal
// leaves the card alone, and it all reads in Chinese.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
//
//   * GitHub's enqueue — `E2E_TEST_GITHUB_MERGE` (`lib/test-github-merge-mock.ts`), whose
//     control marks the repository as requiring a merge queue, so every press ENQUEUES.
//   * The queue's own deliveries — SIGNED `merge_group`, `pull_request` `dequeued` and
//     `check_run` bodies to the real `/api/github/webhook` route, built from the REAL
//     deliveries MOTIR-5627 captured (`tests/fixtures/github/merge-queue/`).
//
// ⚠️ A WEBHOOK REACHES THE ITEM PAGE ON THE NEXT RENDER. The page has no live channel, so
// after each delivery the spec RELOADS, exactly as `acceptance-approve-and-merge.spec.ts`
// does after its merge webhooks. (The card asked for "without a manual reload"; that needs
// a live channel no card in this story ships — recorded on MOTIR-5637.) A press on the page
// itself repaints in place, and that is asserted without a reload.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response, or
// the rail's or row's text. The holds are `chapter()` / `beat()`'s, taken after assertions.
//
// ⚠️ THE 13xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 480_000 });

const PRS = {
  ejected: { number: 13101 },
  rearmed: { number: 13201 },
  neutral: { number: 13301 },
} as const;
type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;
const WEB = `${WEB_REPO.owner}/${WEB_REPO.name}`;
const GROUP_SHA = '5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed5e1ec7ed';
const pra = en.approvalGate.pullRequestApproval;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** A rich message as the page reads it — its tags gone. */
const plain = (text: string, vars: Record<string, string | number> = {}) =>
  fill(text, vars).replace(/<\/?\w+>/g, '');

const prName = (number: number) => `${WEB} · #${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `ejected/${card.identifier.toLowerCase()}-${number}`;

function captured(name: string): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue', `${name}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
}

const installation = { id: Number(E2E_INSTALLATION_ID) };
const repository = { id: Number(WEB_REPO.providerRepoId) };

function journal(): GithubMergeCall[] {
  try {
    return readFileSync(JOURNAL_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GithubMergeCall);
  } catch {
    return [];
  }
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

const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** The authoritative read-back: how many questions the card holds right now. */
async function awaitingGates(card: SeededCard): Promise<number> {
  return adminDb.approvalGate.count({
    where: { workItemId: card.id, kind: 'pull_request_approval', state: 'awaiting' },
  });
}

async function atMostOneQuestion(card: SeededCard): Promise<void> {
  expect(
    await awaitingGates(card),
    `${card.identifier} holds at most one question`,
  ).toBeLessThanOrEqual(1);
}

/** Bring an element to the middle of the viewport, so the video shows what was asserted. The
 *  Development block sits below the fold of the recorded viewport; the rail sits above it. */
async function show(target: Locator): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

async function open(page: Page, card: SeededCard): Promise<void> {
  await page.goto(`/items/${card.identifier}`);
  await expect(developmentCard(page)).toHaveCount(1, { timeout: 60_000 });
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

/** The queue removed `number` — the captured `dequeued` delivery. */
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

const CHECK_NAME = 'Vitest (7/12)';
const CHECK_URL = 'https://github.com/motir-projects-e2e/amerge-web/actions/runs/1/job/2';

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

/** A push to `number`: a new head. */
function synchronize(card: SeededCard, number: number, headSha: string): Record<string, unknown> {
  return {
    action: 'synchronize',
    installation,
    repository,
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: card.title,
      head: { ref: headRefFor(card, number), sha: headSha },
      base: { ref: WEB_REPO.defaultBranch },
      user: { id: E2E_GITHUB_USER.id },
    },
  };
}

/** Press Approve and merge, confirm, and wait for the action. */
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

async function approvedIntoTheQueue(page: Page, card: SeededCard, scenario: Scenario) {
  await open(page, card);
  await pressApproveAndMerge(page);
  await expect(
    prRow(page, PRS[scenario].number).getByText(pra.outcome.queued, { exact: true }),
  ).toBeVisible();
  await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
}

test.describe('a pull request the merge queue ejects', () => {
  let seed: ApproveAndMergeSeed;
  let ejected: SeededCard;
  let rearmed: SeededCard;
  let neutral: SeededCard;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    ejected = seed.merged;
    rearmed = seed.queued;
    neutral = seed.refused;
    writeFileSync(JOURNAL_PATH, '');
    // The repository requires a merge queue: every press ENQUEUES.
    const control: GithubMergeControl = { repositories: [WEB], mergeQueueRepositories: [WEB] };
    writeFileSync(CONTROL_PATH, JSON.stringify(control));

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, ejected, 'ejected');
    await deliverGreen(page, rearmed, 'rearmed');
    await deliverGreen(page, neutral, 'neutral');
  });

  test('the queue ejects it, the card says why, and Queue again puts it back on the same approval', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5461');
    const number = PRS.ejected.number;

    await chapter('A green pull request: the card asks one question', async () => {
      await open(page, ejected);
      await expect(
        developmentCard(page).getByRole('button', { name: pra.verb.approveAndMerge }),
      ).toBeVisible();
      await expect(statusCard(page)).toContainText('In Review');
      expect(await awaitingGates(ejected)).toBe(1);
      await beat();
      await show(prRow(page, number));
    });
    await beat();

    await chapter(
      'Approve and merge: it joins the merge queue, and the card is Approved',
      async () => {
        await pressApproveAndMerge(page);
        expect(
          journal().some((c) => c.path === '/graphql' && c.pullRequest === `${WEB}#${number}`),
        ).toBe(true);
        await expect(
          prRow(page, number).getByText(pra.outcome.queued, { exact: true }),
        ).toBeVisible();
        await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
        await atMostOneQuestion(ejected);
        await beat();
        await show(statusCard(page));
      },
    );
    await beat();

    await chapter('The merge queue ejects it: a check failed', async () => {
      await deliver(page, 'merge_group', checksRequested(number), 'the queue tests the group');
      await deliver(page, 'pull_request', dequeued(number, 'CI_FAILURE'), 'the queue removes it');
      await deliver(page, 'check_run', failedGroupCheck(), 'the failed check reports');
      await page.reload();

      await expect(statusCard(page)).toContainText('Implemented', { timeout: 60_000 });
      const row = prRow(page, number);
      await expect(row.getByText(pra.outcome.leftQueue, { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: pra.outcome.queueAgain })).toBeVisible();
      const dev = developmentCard(page);
      await expect(
        dev.getByText(
          plain(pra.exit.left, { pr: prName(number), reason: pra.exit.reason.CI_FAILURE }),
          { exact: true },
        ),
      ).toBeVisible();
      const check = dev.getByRole('link', {
        name: fill(pra.exit.openCheck, { check: CHECK_NAME }),
      });
      await expect(check).toHaveAttribute('href', CHECK_URL);
      await expect(dev.getByText(plain(pra.exit.unchanged), { exact: true })).toBeVisible();
      // The approval stands: the record still names who approved, and nothing is asked again.
      await expect(dev.getByText(new RegExp(`Approved by ${seed.ownerName}`))).toBeVisible();
      expect(await awaitingGates(ejected)).toBe(0);
      await beat();
      await show(row);
      await beat();
      await show(check);
    });
    await beat();

    await chapter(
      'Queue again: back in the queue, Approved, and nobody is asked again',
      async () => {
        const row = prRow(page, number);
        await show(row);
        const action = serverAction(page);
        await row.getByRole('button', { name: pra.outcome.queueAgain }).click();
        expect((await action).status()).toBe(200);
        await expect(row.getByText(pra.outcome.queued, { exact: true })).toBeVisible();
        await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
        await expect(row.getByRole('button', { name: pra.outcome.queueAgain })).toHaveCount(0);
        await atMostOneQuestion(ejected);
        expect(await awaitingGates(ejected)).toBe(0);
        await beat();
        await show(statusCard(page));
        await beat();

        await page.goto('/workbench?tab=approvals');
        const table = page.getByRole('table', { name: 'To approve' });
        // The other two cards still wait; this one does not.
        await expect(table.getByTestId(/^approval-row-/)).toHaveCount(2, { timeout: 60_000 });
        await expect(
          table.getByTestId(/^approval-row-/).filter({ hasText: ejected.identifier }),
        ).toHaveCount(0);
      },
    );
    await beat();

    await chapter('New commits after an ejection: Motir asks again, once', async () => {
      const n = PRS.rearmed.number;
      await approvedIntoTheQueue(page, rearmed, 'rearmed');
      await deliver(page, 'pull_request', dequeued(n, 'CI_FAILURE'), 'the queue removes it');
      await page.reload();
      await expect(statusCard(page)).toContainText('Implemented', { timeout: 60_000 });
      await expect(
        prRow(page, n).getByRole('button', { name: pra.outcome.queueAgain }),
      ).toBeVisible();
      await atMostOneQuestion(rearmed);

      const pushed = 'feedfacefeedfacefeedfacefeedfacefeedface';
      await deliver(page, 'pull_request', synchronize(rearmed, n, pushed), 'a push');
      await atMostOneQuestion(rearmed);
      await deliver(
        page,
        'check_suite',
        checkSuitePayload({
          conclusion: 'success',
          headSha: pushed,
          prNumber: n,
          headBranch: headRefFor(rearmed, n),
          repo: WEB_REPO,
        }),
        'green at the new head',
      );
      await page.reload();
      await expect(statusCard(page)).toContainText('In Review', { timeout: 60_000 });
      const dev = developmentCard(page);
      await expect(dev.getByRole('button', { name: pra.verb.approveAndMerge })).toBeVisible();
      await expect(dev.getByRole('button', { name: pra.outcome.queueAgain })).toHaveCount(0);
      expect(await awaitingGates(rearmed)).toBe(1);
      await beat();
      await show(prRow(page, n));
    });
    await beat();

    await chapter('Someone took it out of the queue: the card stays Approved', async () => {
      const n = PRS.neutral.number;
      await approvedIntoTheQueue(page, neutral, 'neutral');
      await deliver(page, 'pull_request', dequeued(n, 'MANUAL'), 'someone removes it');
      await page.reload();
      await expect(
        prRow(page, n).getByText(pra.outcome.removedFromQueue, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        prRow(page, n).getByRole('button', { name: pra.outcome.queueAgain }),
      ).toBeVisible();
      await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
      await expect(
        developmentCard(page).getByText(
          plain(pra.exit.removed, { pr: prName(n), reason: pra.exit.reason.MANUAL }),
          { exact: true },
        ),
      ).toBeVisible();
      await atMostOneQuestion(neutral);
      await beat();
      await show(prRow(page, n));
    });
    await beat();

    await chapter('The same ejection, in Chinese', async () => {
      const zpra = zh.approvalGate.pullRequestApproval;
      // A second genuine ejection of the first card, at the same head.
      await deliver(page, 'pull_request', dequeued(number, 'CI_FAILURE'), 'ejected again');
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto(`/items/${ejected.identifier}`);
      const title = zh.github.development.title;
      await expect(developmentCard(page, title)).toHaveCount(1, { timeout: 60_000 });
      const row = prRow(page, number, title);
      await expect(row.getByText(zpra.outcome.leftQueue, { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: zpra.outcome.queueAgain })).toBeVisible();
      const dev = developmentCard(page, title);
      await expect(
        dev.getByText(
          plain(zpra.exit.left, { pr: prName(number), reason: zpra.exit.reason.CI_FAILURE }),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(dev.getByText(plain(zpra.exit.unchanged), { exact: true })).toBeVisible();
      await atMostOneQuestion(ejected);
      await show(row);
    });
    await beat();
  });
});
