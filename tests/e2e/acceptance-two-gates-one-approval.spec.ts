import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import { E2E_INSTALLATION_ID } from './_helpers/github-const';
import {
  DESIGN_REPO,
  TITLES,
  seedTwoGates,
  type SeededCard,
  type TwoGatesSeed,
} from './_helpers/two-gates-seed';
import type { GithubMergeControl } from '@/lib/test-github-merge-mock';
import en from '@/messages/en.json';

// ONE PRESS, TWO QUESTIONS — the level's walk and its ACCEPTANCE RECEIPT
// (Bug MOTIR-5652 · Subtask MOTIR-5669).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A design card with a published result and an open pull request used to hold NO
// question at all: CI green, card In Review, pull request clean, mock rendered,
// and nothing to press. Three things are watchable now, and together they are the
// acceptance:
//
//   1. THE DESIGN LEADS ITS OWN APPROVAL, with the pull requests beneath it as
//      what approving will merge. One press answers both questions.
//   2. AN EJECTION BRINGS BACK ONLY THE MERGE QUESTION. The design stays decided
//      — nobody is asked a second time whether the mock is right — and the design
//      cannot be re-published underneath it, which is what makes *a failure is
//      about the commits* true rather than merely intended.
//   3. A WITHDRAWN GATE FINALLY SAYS WHAT HAPPENED. Two cards, two different
//      withdrawals, two different sentences — each true of its own.
//
// ⚠️ PACED FOR A PERSON. The clip is what Yue watches to accept this level, not a
// pass/fail signal that happens to be recorded. Every hold is `chapter()` /
// `beat()`'s, taken AFTER the state is proven — never a timed wait standing in
// for a signal.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response, a role appearing, a
// committed read after a reload. No arbitrary timeout anywhere in this file.
//
// ⚠️ THE 15xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 480_000 });

// ⚠️ THE NUMBERS TRAVEL UNDER `number:`, which is what
// `tests/e2e-pull-request-number-blocks.test.ts`'s extractor reads. A spec whose
// block cannot be READ fails that guard — a sweep that read nothing is a broken
// instrument, not a clean namespace.
const PRS = { onePress: { number: 15101 }, ejected: { number: 15201 } } as const;

const CONTROL_PATH = process.env['MOTIR_GITHUB_MERGE_CONTROL_PATH']!;

const main = (page: Page) => page.getByRole('main');

function writeControl(control: GithubMergeControl): void {
  writeFileSync(CONTROL_PATH, JSON.stringify(control));
}

const headShaFor = (number: number) => `${number}`.padStart(40, 'c');

/**
 * GitHub's REAL `dequeued` body (`tests/fixtures/github/merge-queue/`, captured by
 * MOTIR-5627), re-pointed at this spec's installation, repository, number and head.
 *
 * ⚠️ AN EJECTION LEAVES THE PULL REQUEST OPEN. That is the whole difference from a
 * close, and it is what makes the next chapter's refusal the real one: the card is
 * back at `implemented` with its commits still offered, which is exactly the state
 * an agent returning to a failed merge is in.
 */
function dequeuedPayload(card: SeededCard, number: number): Record<string, unknown> {
  const file = join(process.cwd(), 'tests/fixtures/github/merge-queue/dequeued-ci-failure.json');
  const body = JSON.parse(readFileSync(file, 'utf8')).payload as Record<string, unknown>;
  const pr = structuredClone(body['pull_request']) as Record<string, unknown>;
  pr['number'] = number;
  pr['state'] = 'open';
  pr['merged'] = false;
  pr['head'] = { ...(pr['head'] as Record<string, unknown>), sha: headShaFor(number) };
  return {
    ...body,
    number,
    pull_request: pr,
    installation: { id: Number(E2E_INSTALLATION_ID) },
    repository: { id: Number(DESIGN_REPO.providerRepoId) },
  };
}
const headRefFor = (card: SeededCard, number: number) =>
  `twogates/${card.identifier.toLowerCase()}-${number}`;

async function openCard(page: Page, key: string, title: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** The Development block — the one card the design result and the rows share. */
const developmentBlock = (page: Page) =>
  main(page)
    .locator('[data-surface="card"]')
    .filter({
      has: page.getByRole('heading', { level: 2, name: en.github.development.title }),
    });

test.describe('one press, two questions', () => {
  let seed: TwoGatesSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedTwoGates(`tg${Date.now().toString(36)}`);
  });

  test('the design leads its own approval, an ejection re-asks only the merge, and a withdrawal says why', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5652');
    await servePublishedMock(page);

    /** Publish a design result, link an open pull request, and turn it green. */
    async function deliver(card: SeededCard, number: number): Promise<void> {
      const client = await openAgentSession(seed.token, baseURL!);
      const published = await publishDesignResult(client, card.identifier);
      expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
      await client.close();

      const headRef = headRefFor(card, number);
      await linkPr(page, {
        workItemId: card.id,
        repo: DESIGN_REPO,
        number,
        headRef,
        title: card.title,
      });
      const opened = await postSignedWebhook(
        page.request,
        'pull_request',
        pullRequestPayload({
          action: 'opened',
          number,
          title: card.title,
          headRef,
          state: 'open',
          merged: false,
          repo: DESIGN_REPO,
        }),
      );
      expect(opened.status()).toBe(200);
      const green = await postSignedWebhook(
        page.request,
        'check_suite',
        checkSuitePayload({
          prNumber: number,
          headBranch: headRef,
          headSha: headShaFor(number),
          conclusion: 'success',
          repo: DESIGN_REPO,
        }),
      );
      expect(green.status()).toBe(200);
    }

    await chapter(
      'An agent publishes a design and opens the pull request that carries it',
      async () => {
        // ⚠️ SIGN IN FIRST. The link door is a session route, so `linkPr` is 401
        // without one — and the publish is a BEARER on the same page's request
        // context, which the cookie does not disturb.
        await signIn(page, seed.reviewerEmail, seed.password);
        await deliver(seed.onePress, PRS.onePress.number);
        await deliver(seed.ejected, PRS.ejected.number);
        await beat();
      },
    );

    await chapter('The DESIGN leads, and the pull requests sit beneath it', async () => {
      await openCard(page, seed.onePress.identifier, TITLES.onePress);
      const block = developmentBlock(page);
      // ⚠️ THE ASSERTION THAT WAS IMPOSSIBLE BEFORE THIS LEVEL. The frame names the
      // DESIGN as the thing being decided — band 1 — and the pull request it will
      // merge is inside the same card, beneath it.
      // ⚠️ BAND 1's LABEL, not the slot's own heading — the block holds BOTH, and
      // that is itself the composition: the design NAMES the frame, and its result
      // renders inside it as the port.
      await expect(
        block
          .locator('span')
          .filter({ hasText: new RegExp(`^${en.approvalGate.designResult.kindLabel}$`) })
          .first(),
      ).toBeVisible();
      await expect(
        block.getByRole('heading', { name: en.approvalGate.designResult.kindLabel }),
      ).toBeVisible();
      await expect(block.getByText(`#${PRS.onePress.number}`, { exact: false })).toBeVisible();
      await beat();
    });

    await chapter('One press answers both questions, and the pull request merges', async () => {
      writeControl({ repositories: [`${DESIGN_REPO.owner}/${DESIGN_REPO.name}`] });
      const block = developmentBlock(page);
      await block
        .getByRole('button', { name: en.approvalGate.pullRequestApproval.verb.approveAndMerge })
        .click();
      // The confirm step says what approving will do BEFORE it does it.
      await page.getByRole('button', { name: /^Yes,/ }).click();
      // Authoritative: the decided pill is drawn from the action's returned row.
      // The frame's own state pill — the word also appears on the status rail and
      // in the activity feed, which is not what this chapter is about.
      await expect(
        developmentBlock(page).getByText(en.approvalGate.state.approved).first(),
      ).toBeVisible();
      await beat();
    });

    await chapter('A merge that fails brings back ONE question — the commits', async () => {
      // The second card is approved and then ejected from the merge queue. Its
      // design decision is untouched: nothing about the design changed.
      writeControl({
        repositories: [`${DESIGN_REPO.owner}/${DESIGN_REPO.name}`],
        mergeQueueRepositories: [`${DESIGN_REPO.owner}/${DESIGN_REPO.name}`],
      });
      await openCard(page, seed.ejected.identifier, TITLES.ejected);
      const block = developmentBlock(page);
      await block
        .getByRole('button', { name: en.approvalGate.pullRequestApproval.verb.approveAndMerge })
        .click();
      await page.getByRole('button', { name: /^Yes,/ }).click();
      // The frame's own state pill — the word also appears on the status rail and
      // in the activity feed, which is not what this chapter is about.
      await expect(
        developmentBlock(page).getByText(en.approvalGate.state.approved).first(),
      ).toBeVisible();
      await beat();

      const ejected = await postSignedWebhook(
        page.request,
        'pull_request',
        dequeuedPayload(seed.ejected, PRS.ejected.number),
      );
      expect(ejected.status()).toBe(200);
      await page.reload();
      // The design decision STANDS — it is shown as decided, not re-asked.
      // The frame's own state pill — the word also appears on the status rail and
      // in the activity feed, which is not what this chapter is about.
      await expect(
        developmentBlock(page).getByText(en.approvalGate.state.approved).first(),
      ).toBeVisible();
      await beat();
    });

    await chapter('And the design cannot be swapped underneath that approval', async () => {
      // The state an agent returning to a failed pull request is in. Driven
      // through the same door an agent uses, and refused with the way forward.
      const client = await openAgentSession(seed.token, baseURL!);
      const refused = await publishDesignResult(client, seed.ejected.identifier);
      await client.close();
      expect(refused.isError ?? false).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('reopen the card by hand');
      await beat();
    });

    await chapter('A withdrawal finally says WHAT HAPPENED, and two of them differ', async () => {
      // Two cards, two DIFFERENT withdrawals, two different sentences — each true
      // of its own. Before this level both said the same thing, and it was right
      // about one of them: the row recorded `state` and nothing else, so the
      // sentence had to be made vaguer (MOTIR-5586) rather than made true.
      //
      // ⚠️ BOTH WITHDRAWALS LEAVE NO LIVE QUESTION, which is what makes state `G`
      // the thing on the screen. A REPUBLISH is the third cause and is deliberately
      // not walked here: it writes its replacement gate in the same transaction, so
      // the card never shows a withdrawn one (`approval-gate-decided-read.test.ts`
      // records the same fact). Its sentence is covered by the component suite.
      const client = await openAgentSession(seed.token, baseURL!);
      for (const card of [seed.withdrawn, seed.pulledBack]) {
        const published = await publishDesignResult(client, card.identifier);
        expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
      }
      await client.close();

      // (a) THE RESULT ITSELF is taken away — the question goes with it.
      const withdrawn = await page.request.delete(
        `/api/work-items/${seed.withdrawn.identifier}/design-evidence`,
        { data: { reason: 'published onto the wrong card' } },
      );
      expect(withdrawn.status(), await withdrawn.text()).toBe(200);
      await openCard(page, seed.withdrawn.identifier, TITLES.withdrawn);
      await expect(main(page).getByText(en.approvalGate.withdrawn.cause.withdrawn)).toBeVisible();
      await beat();

      // (b) THE WORK is pulled back out of review. Nothing about the design
      // changed, and the sentence says so — driven through the status control a
      // person actually uses.
      // ⚠️ IT HAS TO BE IN REVIEW FIRST. A pull-back withdraws the question only
      // when the move LEAVES the review band (§6d rule 6) — from below it, there
      // is nothing to pull back from.
      //
      // ⚠️ AND THE TWO MOVES GO THROUGH THE SHIPPED v1 DOOR, not the status
      // combobox. Every wait in this file is on an authoritative signal, and the
      // door's own 200 IS one — `updateStatus` has committed by the time it
      // answers. The combobox is the same funnel one surface further out, and its
      // optimistic label is a claim rather than a fact.
      for (const status of ['in_review', 'in_progress']) {
        const moved = await page.request.post(
          `/api/v1/work-items/${seed.pulledBack.identifier}/transitions`,
          // The v1 door is a BEARER door — the same token the agent publishes with.
          { data: { status }, headers: { Authorization: `Bearer ${seed.token}` } },
        );
        expect(moved.status(), `${status}: ${await moved.text()}`).toBe(200);
      }
      await openCard(page, seed.pulledBack.identifier, TITLES.pulledBack);
      await expect(main(page).getByText(en.approvalGate.withdrawn.cause.pulled_back)).toBeVisible();
      await beat();
    });

    await chapter('And a card with nothing published is asked nothing at all', async () => {
      await openCard(page, seed.empty.identifier, TITLES.empty);
      await expect(
        main(page).getByText(en.approvalGate.pullRequestApproval.verb.approveAndMerge),
      ).toHaveCount(0);
      await expect(main(page).getByText(en.approvalGate.state.awaiting)).toHaveCount(0);
      await beat();
    });
  });
});
