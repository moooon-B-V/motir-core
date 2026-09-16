import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import {
  API_REPO,
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeedRepo,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import type { GithubMergeCall, GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// APPROVE AND MERGE THE PULL REQUESTS IN MOTIR — THE ACCEPTANCE RECEIPT (Story MOTIR-4909 ·
// Subtask MOTIR-5487).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A card's pull requests turn green and ONE question appears: on the To-approve tab, and in
// the card's Development block, where the pull requests and How to test are the subject.
// The person presses *Approve and merge*, reads what it will do, confirms — and the card is
// Approved at once while each pull request merges in place. The merge webhook, and nothing
// else, finishes the card. Then the two answers a demo would hide: a pull request that joins
// its merge queue keeps the card Approved until the queue lands it, and a refused one says
// which pull request and why, the approval standing, with a retry on that row alone. A
// reporter who is not asked sees the question and no verb. And it all reads in Chinese.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * GitHub's merge, queue and refusal — `E2E_TEST_GITHUB_MERGE`
//     (`lib/test-github-merge-mock.ts`, MOTIR-5572), selected in
//     `playwright.acceptance.config.ts`'s `webServer.env` with its control and journal paths.
//     The spec WRITES what GitHub answers per pull request and READS the journal to prove the
//     press reached that seam, before it asserts any outcome.
//   * The pull requests, their green checks and their merges — SIGNED deliveries to the real
//     `/api/github/webhook` route (`github-seed.ts`).
//   * The links — the real link door (`pr-link.ts`).
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, the server action's response, a
// role, or a committed read after a reload. No timed wait anywhere in this file; the holds
// are `chapter()` / `beat()`'s, taken after the assertion.
//
// ⚠️ THE 10xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 480_000 });

const PRS = {
  merged: { web: { number: 10101 }, api: { number: 10102 } },
  queued: { web: { number: 10201 }, api: { number: 10202 } },
  refused: { web: { number: 10301 }, api: { number: 10302 } },
  zh: { web: { number: 10401 }, api: { number: 10402 } },
} as const;

type Scenario = keyof typeof PRS;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;
const JOURNAL_PATH = process.env['MOTIR_GITHUB_MERGE_JOURNAL_PATH']!;

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

/** A pull request as every surface names it: `owner/name · #n`. */
const prName = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name} · #${number}`;
const prKey = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name}#${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `amerge/${card.identifier.toLowerCase()}-${number}`;

function writeControl(control: GithubMergeControl): void {
  writeFileSync(CONTROL_PATH, JSON.stringify(control));
}

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

/** The item page's Development card — the section card headed by its title. */
const developmentCard = (page: Page, title = en.github.development.title): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });

/** One pull-request row of the Development card, by its `owner/name · #n` meta line. */
const prRow = (page: Page, repo: SeedRepo, number: number, title?: string): Locator =>
  developmentCard(page, title)
    .locator('li')
    .filter({ hasText: prName(repo, number) });

/** The detail rail's Status field card (the `approval-gate-repaint.spec.ts` precedent). */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

/** Arm a wait for the next server action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

/** Open both pull requests of a card, link them, and turn both green — the path a run and its
 *  CI walk. Each delivery's own response is the signal the next one reads on. */
async function deliverGreen(page: Page, card: SeededCard, scenario: Scenario): Promise<void> {
  for (const [repo, pr] of [
    [WEB_REPO, PRS[scenario].web],
    [API_REPO, PRS[scenario].api],
  ] as const) {
    const headRef = headRefFor(card, pr.number);
    const opened = await postSignedWebhook(
      page.request,
      'pull_request',
      pullRequestPayload({
        action: 'opened',
        number: pr.number,
        title: `${card.title} — ${repo.name}`,
        headRef,
        state: 'open',
        merged: false,
        repo,
      }),
    );
    expect(opened.status(), `open ${prKey(repo, pr.number)}`).toBe(200);
    await linkPr(page, { workItemId: card.id, repo, number: pr.number, headRef });
  }
  for (const [repo, pr] of [
    [WEB_REPO, PRS[scenario].web],
    [API_REPO, PRS[scenario].api],
  ] as const) {
    const green = await postSignedWebhook(
      page.request,
      'check_suite',
      checkSuitePayload({
        conclusion: 'success',
        headSha: headShaFor(pr.number),
        prNumber: pr.number,
        headBranch: headRefFor(card, pr.number),
        repo,
      }),
    );
    expect(green.status(), `green ${prKey(repo, pr.number)}`).toBe(200);
  }
}

/** The merge webhook for one pull request; asserts the sync answered. */
async function mergedWebhook(
  page: Page,
  card: SeededCard,
  repo: SeedRepo,
  number: number,
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'closed',
      number,
      title: `${card.title} — ${repo.name}`,
      headRef: headRefFor(card, number),
      state: 'closed',
      merged: true,
      repo,
    }),
  );
  expect(res.status(), `merge ${prKey(repo, number)} → ${(await res.text()).slice(0, 300)}`).toBe(
    200,
  );
}

/** Press Approve and merge, read the confirm step, confirm, and wait for the action. */
async function pressApproveAndMerge(
  page: Page,
  card: SeededCard,
  scenario: Scenario,
  messages: typeof en = en,
): Promise<void> {
  const pra = messages.approvalGate.pullRequestApproval;
  const dev = developmentCard(page, messages.github.development.title);
  await dev.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }).click();
  for (const [repo, pr] of [
    [WEB_REPO, PRS[scenario].web],
    [API_REPO, PRS[scenario].api],
  ] as const) {
    await expect(
      dev.getByText(fill(pra.confirm.mergeOrQueue, { pr: prName(repo, pr.number) }), {
        exact: true,
      }),
    ).toBeVisible();
  }
  await expect(
    dev.getByText(fill(pra.confirm.movesToApproved, { key: card.identifier }), { exact: true }),
  ).toBeVisible();
  const action = serverAction(page);
  await dev
    .getByRole('button', {
      name: fill(messages.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge }),
      exact: true,
    })
    .click();
  expect((await action).status()).toBe(200);
}

test.describe('approve and merge a card’s pull requests in Motir', () => {
  let seed: ApproveAndMergeSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(Date.now().toString(36));
    writeFileSync(JOURNAL_PATH, '');
    // What GitHub answers: both repositories merge, except the queued card's api pull request
    // (its repository has a merge queue) and the refused card's (a conflict, until retried).
    writeControl({
      repositories: [`${WEB_REPO.owner}/${WEB_REPO.name}`, `${API_REPO.owner}/${API_REPO.name}`],
      pullRequests: {
        [prKey(API_REPO, PRS.queued.api.number)]: { outcome: 'enqueued' },
        [prKey(API_REPO, PRS.refused.api.number)]: { outcome: 'refused', refusal: 'conflict' },
      },
    });

    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, seed.merged, 'merged');
    await deliverGreen(page, seed.queued, 'queued');
    await deliverGreen(page, seed.refused, 'refused');
    await deliverGreen(page, seed.zh, 'zh');
  });

  test('green pull requests raise one question; Approve and merge approves, merges, queues, refuses and retries', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4909');
    const pra = en.approvalGate.pullRequestApproval;
    const mergedWeb = PRS.merged.web.number;
    const mergedApi = PRS.merged.api.number;

    await chapter(
      'Both pull requests are green: the question is waiting on To approve',
      async () => {
        await page.goto('/workbench?tab=approvals');
        // ONE row per card, FULL STOP (Bug MOTIR-5603 · MOTIR-5615; the delta mock
        // `design/workbench/approvals-row--one-gate.mock.html`, panels 1-2). § 23 used to
        // promise a *Not built yet* row per pull request beside this one; § 25 struck that,
        // and the merge kind now raises nothing. So the count is taken over EVERY row on
        // the tab, not filtered to one kind — filtering is what would hide a regression.
        const table = page.getByRole('table', { name: 'To approve' });
        const rows = table.getByTestId(/^approval-row-/);
        await expect(rows).toHaveCount(4, { timeout: 60_000 });
        const row = rows.filter({ hasText: seed.merged.identifier });
        await expect(row).toHaveCount(1);
        // Every pull request in the set, in the set's own order, and no "Not built yet".
        await expect(
          row.getByText(`${prName(API_REPO, mergedApi)}, ${prName(WEB_REPO, mergedWeb)}`, {
            exact: true,
          }),
        ).toBeVisible();
        await expect(row.getByText('Not built yet')).toHaveCount(0);
      },
    );
    await beat();

    await chapter('The card: one frame over both pull requests and How to test', async () => {
      // The row's own decide-cell control, NOT the whole-row overlay link: that link is
      // `absolute inset-0 z-0`, so the row's work-item link (`z-10`) covers its centre and a
      // pointer click there never lands on it — CI run 34952412734 retried it to the timeout.
      await page
        .getByRole('table', { name: 'To approve' })
        .getByTestId(/^approval-row-/)
        .filter({ hasText: en.workbench.approvals.pullRequest.kindLabel })
        .filter({ hasText: seed.merged.identifier })
        .getByRole('button', { name: en.workbench.approvals.pullRequest.openWorkItem, exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`/items/${seed.merged.identifier}$`));
      const dev = developmentCard(page);
      await expect(dev).toHaveCount(1, { timeout: 60_000 });
      const port = dev.getByRole('group', { name: 'The subject being decided', exact: true });
      await expect(port.getByRole('group', { name: 'How to test', exact: true })).toHaveCount(1);
      await expect(prRow(page, WEB_REPO, mergedWeb)).toHaveCount(1);
      await expect(prRow(page, API_REPO, mergedApi)).toHaveCount(1);
      await expect(dev.getByRole('button', { name: pra.verb.approveAndMerge })).toBeVisible();
      await expect(
        dev.getByText(
          fill(pra.consequence.named, {
            prs: fill(pra.list.pair, {
              a: prName(API_REPO, mergedApi),
              b: prName(WEB_REPO, mergedWeb),
            }),
            key: seed.merged.identifier,
          }),
          { exact: true },
        ),
      ).toBeVisible();
    });
    await beat();

    await chapter('The reporter is not the one asked: the question, and no verb', async () => {
      await page.context().clearCookies();
      await signIn(page, seed.bystanderEmail, seed.password);
      await page.goto(`/items/${seed.merged.identifier}`);
      const dev = developmentCard(page);
      await expect(
        dev.getByRole('group', { name: 'The subject being decided', exact: true }),
      ).toHaveCount(1, { timeout: 60_000 });
      await expect(
        dev.getByText(fill(en.approvalGate.waitingOn, { name: seed.ownerName })),
      ).toBeVisible();
      await expect(dev.getByRole('button', { name: pra.verb.approveAndMerge })).toHaveCount(0);
    });
    await beat();

    await chapter(
      'Approve and merge: the card is Approved, and both pull requests merge',
      async () => {
        await page.context().clearCookies();
        await signIn(page, seed.ownerEmail, seed.password);
        await page.goto(`/items/${seed.merged.identifier}`);
        await expect(developmentCard(page)).toHaveCount(1, { timeout: 60_000 });
        await pressApproveAndMerge(page, seed.merged, 'merged');

        // The press reached the merge seam — and not the real host — for both pull requests.
        const merges = journal()
          .filter((c) => c.method === 'PUT')
          .map((c) => c.pullRequest);
        expect(merges).toEqual(
          expect.arrayContaining([prKey(WEB_REPO, mergedWeb), prKey(API_REPO, mergedApi)]),
        );
        await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
        await expect(
          prRow(page, WEB_REPO, mergedWeb).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
        await expect(
          prRow(page, API_REPO, mergedApi).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
      },
    );
    await beat();

    await chapter(
      'GitHub reports both merges: the webhook, and nothing else, finishes the card',
      async () => {
        await mergedWebhook(page, seed.merged, WEB_REPO, mergedWeb);
        await mergedWebhook(page, seed.merged, API_REPO, mergedApi);
        await page.reload();
        await expect(statusCard(page)).toContainText('Done', { timeout: 60_000 });
      },
    );
    await beat();

    await chapter('A pull request that joins its merge queue keeps the card Approved', async () => {
      const web = PRS.queued.web.number;
      const api = PRS.queued.api.number;
      await page.goto(`/items/${seed.queued.identifier}`);
      await expect(developmentCard(page)).toHaveCount(1, { timeout: 60_000 });
      await pressApproveAndMerge(page, seed.queued, 'queued');

      await expect(
        prRow(page, API_REPO, api).getByText(pra.outcome.queued, { exact: true }),
      ).toBeVisible();
      await expect(
        prRow(page, WEB_REPO, web).getByText(pra.outcome.merged, { exact: true }),
      ).toBeVisible();
      await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
      expect(
        journal().some((c) => c.path === '/graphql' && c.pullRequest === prKey(API_REPO, api)),
      ).toBe(true);
      await beat();

      // After a reload it still reads Queued to merge — the read, not the press's memory.
      await page.reload();
      await expect(
        prRow(page, API_REPO, api).getByText(pra.outcome.queued, { exact: true }),
      ).toBeVisible({
        timeout: 60_000,
      });

      // The merged pull request's webhook does not finish the card: the queue has not landed.
      await mergedWebhook(page, seed.queued, WEB_REPO, web);
      await page.reload();
      await expect(statusCard(page)).toContainText(en.approvalGate.state.approved, {
        timeout: 60_000,
      });
      // The queue lands it.
      await mergedWebhook(page, seed.queued, API_REPO, api);
      await page.reload();
      await expect(statusCard(page)).toContainText('Done', { timeout: 60_000 });
    });
    await beat();

    await chapter(
      'A refused pull request is named, the approval stands, and Retry merges it',
      async () => {
        const web = PRS.refused.web.number;
        const api = PRS.refused.api.number;
        await page.goto(`/items/${seed.refused.identifier}`);
        await expect(developmentCard(page)).toHaveCount(1, { timeout: 60_000 });
        await pressApproveAndMerge(page, seed.refused, 'refused');

        const alert = developmentCard(page).getByRole('alert');
        await expect(alert).toContainText(fill(pra.refused.title, { pr: prName(API_REPO, api) }));
        await expect(alert).toContainText(en.approvalGate.refusal.mergeConflict.title);
        await expect(alert).toContainText(
          fill(pra.refused.stands, { other: prName(WEB_REPO, web) }),
        );
        await expect(
          prRow(page, API_REPO, api).getByText(pra.outcome.refused, { exact: true }),
        ).toBeVisible();
        await expect(
          prRow(page, WEB_REPO, web).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
        await expect(statusCard(page)).toContainText(en.approvalGate.state.approved);
        await beat();

        // The conflict is resolved on GitHub; Retry merges that pull request, and only that row moves.
        writeControl({
          repositories: [
            `${WEB_REPO.owner}/${WEB_REPO.name}`,
            `${API_REPO.owner}/${API_REPO.name}`,
          ],
        });
        const action = serverAction(page);
        await prRow(page, API_REPO, api).getByRole('button', { name: pra.outcome.retry }).click();
        expect((await action).status()).toBe(200);
        await expect(
          prRow(page, API_REPO, api).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
        await expect(developmentCard(page).getByRole('alert')).toHaveCount(0);
        await expect(
          prRow(page, WEB_REPO, web).getByText(pra.outcome.merged, { exact: true }),
        ).toBeVisible();
      },
    );
    await beat();

    await chapter('The same walk in Chinese', async () => {
      const zpra = zh.approvalGate.pullRequestApproval;
      const web = PRS.zh.web.number;
      const api = PRS.zh.api.number;
      // Against the SITE ROOT, not `page.url()`: Playwright derives a cookie's path from the
      // url's directory, and this chapter starts on `/items/<key>`, so a cookie set from it
      // is scoped to `/items/` and never reaches `/workbench` — CI run 34976200379 walked
      // the To-approve tab in English for exactly that reason.
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto('/workbench?tab=approvals');
      // Picked by its Open work item button rather than the kind label. That was once a
      // necessity — in zh each merge gate's subject line read `… · 拉取请求`, making the
      // label a substring of all three of the card's rows (CI run 34979375067). MOTIR-5615
      // removed those rows and MOTIR-5616 retired `mergeSubjectMeta`, so the card now has
      // ONE row and the ambiguity is gone; the button is kept as the selector because it
      // asserts the row is the decidable one, which the label alone never did.
      const row = page
        .getByRole('main')
        .getByTestId(/^approval-row-/)
        .filter({ hasText: seed.zh.identifier })
        .filter({
          has: page.getByRole('button', {
            name: zh.workbench.approvals.pullRequest.openWorkItem,
            exact: true,
          }),
        });
      await expect(
        row.getByText(zh.workbench.approvals.pullRequest.kindLabel, { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      // The row's decide-cell control, for the reason the English chapter gives.
      await row
        .getByRole('button', { name: zh.workbench.approvals.pullRequest.openWorkItem, exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`/items/${seed.zh.identifier}$`));
      const dev = developmentCard(page, zh.github.development.title);
      await expect(dev).toHaveCount(1, { timeout: 60_000 });
      await expect(dev.getByRole('button', { name: zpra.verb.approveAndMerge })).toBeVisible();
      await expect(
        dev.getByText(
          fill(zpra.consequence.named, {
            prs: fill(zpra.list.pair, { a: prName(API_REPO, api), b: prName(WEB_REPO, web) }),
            key: seed.zh.identifier,
          }),
          { exact: true },
        ),
      ).toBeVisible();
      await pressApproveAndMerge(page, seed.zh, 'zh', zh as unknown as typeof en);
      await expect(
        prRow(page, WEB_REPO, web, zh.github.development.title).getByText(zpra.outcome.merged, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        prRow(page, API_REPO, api, zh.github.development.title).getByText(zpra.outcome.merged, {
          exact: true,
        }),
      ).toBeVisible();
    });
    await beat();
  });
});
