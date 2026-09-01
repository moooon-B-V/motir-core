import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  checkSuitePayload,
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import { E2E_REPO } from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import { boardViewportWidth, getBoard, columnByStatus, cardIdsIn } from './_helpers/board';
import { signUp } from './_helpers/shell-session';
import { resetDatabase } from './_helpers/db-reset';
import { test, expect } from './_helpers/promoted-regression';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// ACCEPTANCE — a card is In Review only when CI is GREEN (Story MOTIR-2999 ·
// Subtask MOTIR-3009). The story's `verification_recipe`, driven end to end
// through the shipped webhook handlers, and recorded as the receipt Yue watches
// to accept the story.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing. The product
// change is a card MOVING ON ITS OWN — and, twice, a card DELIBERATELY NOT
// MOVING. A recording that cuts straight from "implemented" to "in review" has
// satisfied every assertion and shown a reviewer nothing: what they are being
// asked to accept is that the build, not the agent, decides when a human is
// called. So the two beats that hold — checks still running, and a terminal
// FAILURE — get their own chapters, and the board sits after each delivery long
// enough for the card to be seen where it did not move from.
//
// ── THE LANE, per `docs/acceptance-lane-triage.md` ──────────────────────────
// This runs in the ACCEPTANCE lane, and the reason is the RECEIPT, not the
// environment: nothing here needs a cloud-on flag. The webhook route, the CI
// feedback path, the promotion and the board are plain product behaviour that
// `playwright.config.ts`'s server runs exactly as well. So its disposition when
// the receipt freezes is a PROMOTE into the main lane — recorded as a row in
// the triage table with this card, rather than left for someone to rediscover.
//
// ── THE SHIPPED SEAM, no new mechanism ──────────────────────────────────────
// Every CI and merge event is a SIGNED delivery to the REAL `/api/github/webhook`
// (`postSignedWebhook` + `pullRequestPayload` + `checkSuitePayload`, Story
// 7.10's helpers), so the signature gate, the change-request resolver, the CI
// feedback path, the promotion and the completion gate all run for real. The
// ONE thing the helpers could not express is a check suite that has NOT
// finished — they were written when only a terminal aggregate mattered — so
// `checkSuitePayload` gained an optional non-terminal form, additively.
//
// DETERMINISM: every wait is on an authoritative signal — the delivery's own
// 200 plus its `result` body (the route awaits the full service handling before
// responding), then a fresh `/api/board` projection read. The board is
// re-rendered for the CAMERA after that read, never as the proof: the assertion
// has already been made against committed state, so the clip cannot be the
// thing that decides whether the test passed.

// ⚠️ THIS SPEC OUTRUNS THE LANE'S 90s DEFAULT, ON PURPOSE. The recipe is six
// steps and each is paced for a viewer, so the recording alone is ~65s; a CI
// runner's setup on top of that crossed 90s and timed the test out mid-board-read.
// The precedent is `child-panel-graph.spec.ts`, which configures its own budget
// the same way. Raising it does NOT slow a green run — a `timeout` is a ceiling,
// not a wait — and the pacing is the deliverable here, not overhead to trim.
test.describe.configure({ timeout: 300_000 });

const EMAIL = 'e2e-implemented-lifecycle@example.com';

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/** The workspace sign-up auto-created, plus one project pinned by fallback.
 *
 *  ⚠️ NO `@/lib/db` singleton statements (`tests/rls/test-singleton-statement-guard`
 *  ratchets that population down over `tests/e2e/**`): a direct singleton write is
 *  REFUSED under `motir_app` and a direct read returns [], neither of which raises.
 *  The ids come from the shipped `/api/workspaces/current` through the browser's
 *  own session, and the project from the service. */
async function seedActiveProject(page: Page, identifier: string): Promise<Tenant> {
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Implemented lifecycle',
    identifier,
  });
  // No active-project write is needed: `getActiveProject` falls back to the
  // workspace's first non-archived project, and this workspace has exactly one.
  return { userId: membership.userId, workspaceId: workspace.id, projectId: project.id };
}

async function mkItem(
  page: Page,
  t: Tenant,
  title: string,
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId: t.projectId, kind: 'task', title },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition → ${statusKey}`).toBe(200);
}

/** The AUTHORITATIVE status of a card — the same projection the board renders,
 *  read from the server rather than from the page. Every "did it move?" question
 *  in this spec is answered here first; the board is then shown to the camera. */
async function statusOnBoard(page: Page, workItemId: string): Promise<string> {
  const board = await getBoard(page.request);
  const column = board.columns.find((c) => c.cards.some((card) => card.id === workItemId));
  expect(column, `a board column holding ${workItemId}`).toBeTruthy();
  return column!.statusKeys[0]!;
}

/** Deliver one signed `pull_request` event and assert the outcome the sync
 *  reported — the committed-state signal every following step reads on. */
async function deliverPr(
  page: Page,
  args: {
    action: 'opened' | 'closed';
    number: number;
    title: string;
    headRef: string;
    merged?: boolean;
    expect: Record<string, unknown>;
  },
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: args.action,
      number: args.number,
      title: args.title,
      headRef: args.headRef,
      state: args.action === 'closed' ? 'closed' : 'open',
      merged: args.merged ?? false,
    }),
  );
  // Carry the BODY into the failure message: a 500 here is a server-side fault,
  // and a bare status code sends the reader to the server log to find out which.
  const body = await res.text();
  expect(res.status(), `pull_request ${args.action} → ${body.slice(0, 400)}`).toBe(200);
  expect(
    (JSON.parse(body) as { result: Record<string, unknown> }).result,
    `pull_request ${args.action}`,
  ).toMatchObject(args.expect);
}

/** Deliver one signed `check_suite` event — running, failing or green. */
async function deliverChecks(
  page: Page,
  args: {
    conclusion: 'success' | 'failure' | null;
    status?: 'in_progress' | 'completed';
    headSha: string;
    prNumber: number;
    headBranch: string;
    expect: Record<string, unknown>;
  },
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: args.conclusion,
      status: args.status ?? 'completed',
      headSha: args.headSha,
      prNumber: args.prNumber,
      headBranch: args.headBranch,
    }),
  );
  const body = await res.text();
  expect(res.status(), `check_suite → ${body.slice(0, 400)}`).toBe(200);
  expect((JSON.parse(body) as { result: Record<string, unknown> }).result).toMatchObject(
    args.expect,
  );
}

/** Show the board to the camera, and assert the card is rendered in the column
 *  the projection already said it is in. The ASSERTION is `statusOnBoard`; this
 *  is the same fact, in the surface a person reads.
 *
 *  ⚠️ A board card's testid carries its IDENTIFIER (`board-card-IMPL-1`,
 *  `BoardCard.tsx`), not its id — the column's carries the column ID. Mixing the
 *  two finds nothing and reads as "the card is in the wrong column". */
async function showBoard(page: Page, columnId: string, identifier: string): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId(`board-column-${columnId}`).getByTestId(`board-card-${identifier}`),
  ).toBeVisible();
}

test('a card reaches In Review only when CI is green, and one merge closes every card the pull request carries', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2999');
  // ISOLATION (Bug MOTIR-3248). Pull-request numbers are a namespace SHARED
  // across the whole lane: `github_pull_request` is @@unique([repoId, number])
  // and every spec's `seedGithubInstallation` upserts the SAME mirrored repo
  // row, so a spec that does not reset inherits its predecessors' deliveries —
  // and WHICH specs precede it is a shard partition that moves whenever any
  // file is added to the lane. This spec used to rely on landing in a friendly
  // partition; it no longer does. The cascade that makes the reset reach those
  // rows is measured in `tests/db-reset-cascade.test.ts`, and the thousand-block
  // this file owns is enforced by `tests/e2e-pull-request-number-blocks.test.ts`.
  // Both layers on purpose: the reset makes this spec independent of what ran
  // before it, the block makes it independent of anyone else remembering to.
  await resetDatabase();

  // Every default status gets a column, and the story ADDS one — so the width
  // comes from the status count rather than a number that silently stops fitting.
  await page.setViewportSize(boardViewportWidth());
  await signUp(page, EMAIL);
  const t = await seedActiveProject(page, 'IMPL');
  await seedGithubInstallation(t.workspaceId);

  const card = await mkItem(page, t, 'Add the export button');
  const branchCards = [
    await mkItem(page, t, 'Rename the settings tab'),
    await mkItem(page, t, 'Fix the empty-state copy'),
  ];
  const headRef = `subtask/${card.identifier.toLowerCase()}-add-the-export-button`;

  const board = await getBoard(page.request);
  const todoColumn = columnByStatus(board, 'todo');
  const implementedColumn = columnByStatus(board, 'implemented');
  const inReviewColumn = columnByStatus(board, 'in_review');
  const doneColumn = columnByStatus(board, 'done');

  // ── 1 — the board, and the column this story adds ─────────────────────────
  await chapter('The board has a new column: Implemented', async () => {
    await showBoard(page, todoColumn.id, card.identifier);
    await beat();

    // The column is there, named, and BETWEEN In Progress and In Review — the
    // order is the claim, because a status appended to the end would read as an
    // afterthought rather than as a step of the walk.
    const columnNames = board.columns.map((c) => c.name);
    expect(columnNames).toContain('Implemented');
    expect(columnNames.indexOf('Implemented')).toBeGreaterThan(columnNames.indexOf('In Progress'));
    expect(columnNames.indexOf('Implemented')).toBeLessThan(columnNames.indexOf('In Review'));
    await expect(page.getByTestId(`board-column-${implementedColumn.id}`)).toBeVisible();
    await expect(page.getByText('Implemented', { exact: true }).first()).toBeVisible();
    await beat();
  });

  // ── 2 — the run finishes: BUILT, not reviewable ───────────────────────────
  await chapter(
    'The run finishes and opens a pull request — the card lands in Implemented',
    async () => {
      await transition(page, card.id, 'in_progress');
      // LINKED first. Since MOTIR-3674 a pull request belongs to a card only by
      // an explicit link — the title naming the key associates nothing — so the
      // link is what makes the Implemented landing below a statement about the
      // LIFECYCLE, which is this receipt's subject, rather than about the parse
      // that used to find the card.
      await linkPr(page, { workItemId: card.id, repo: E2E_REPO, number: 6101, headRef });
      await deliverPr(page, {
        action: 'opened',
        number: 6101,
        title: `feat: ${card.identifier} add the export button`,
        headRef,
        // THE FIRST HALF OF THE STORY: an open pull request means `implemented`.
        // Before MOTIR-2999 this same delivery said In Review, and a human was
        // called to a branch whose build had not run.
        expect: { event: 'pull_request', outcome: 'transitioned', toStatus: 'implemented' },
      });
      expect(await statusOnBoard(page, card.id)).toBe('implemented');

      await showBoard(page, implementedColumn.id, card.identifier);
      await beat();
    },
  );

  // ── 3 — checks still running: nothing moves ───────────────────────────────
  await chapter('Checks start running — the card does not move', async () => {
    await deliverChecks(page, {
      conclusion: null,
      status: 'in_progress',
      headSha: 'e2e-sha-6101-a',
      prNumber: 6101,
      headBranch: headRef,
      // Recorded, not verdicted: the row lands (`pending_recorded`) and the
      // path returns NO `ciState` at all, because a suite that has not finished
      // is not a verdict to promote on.
      expect: { event: 'ci', outcome: 'pending_recorded' },
    });
    expect(await statusOnBoard(page, card.id)).toBe('implemented');

    await showBoard(page, implementedColumn.id, card.identifier);
    await beat();
  });

  // ── 4 — the build FAILS. The card stays, and says why. ────────────────────
  await chapter('The build FAILS — the card stays in Implemented and says why', async () => {
    await deliverChecks(page, {
      conclusion: 'failure',
      headSha: 'e2e-sha-6101-a',
      prNumber: 6101,
      headBranch: headRef,
      expect: { event: 'ci', outcome: 'failed', ciState: 'failing' },
    });
    // THE BEAT THIS SPEC EXISTS FOR. A lifecycle test that only walks the happy
    // path would pass against an implementation that promoted every card
    // unconditionally — which is the bug the story exists to prevent.
    expect(await statusOnBoard(page, card.id)).toBe('implemented');

    await showBoard(page, implementedColumn.id, card.identifier);
    await beat();

    // …and the card carries the reason, so the hold is legible rather than
    // mysterious: the CI feedback comment the shipped path posts.
    await page.goto(`/items/${card.identifier}`);
    await expect(page.getByText('CI failed', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('needs another pass', { exact: false }).first()).toBeVisible();
    await beat();
  });

  // ── 5 — the build goes GREEN, and the card moves ITSELF ───────────────────
  await chapter('The fix goes green — the card moves itself to In Review', async () => {
    // A new push, so a new sha: the fix's verdict, not a re-run of the old one.
    await deliverChecks(page, {
      conclusion: 'success',
      headSha: 'e2e-sha-6101-b',
      prNumber: 6101,
      headBranch: headRef,
      expect: { event: 'ci', outcome: 'verified', ciState: 'passing' },
    });
    // NOBODY TOUCHED THE CARD between the delivery and this read — no drag, no
    // click, not even a page load. The build moved it.
    expect(await statusOnBoard(page, card.id)).toBe('in_review');

    await showBoard(page, inReviewColumn.id, card.identifier);
    await beat();
    await beat();
  });

  // ── 6 — one merge closes every card the pull request carries ──────────────
  await chapter('One pull request carries three cards — one merge closes them all', async () => {
    // The `motir auto` shape: several cards integrated onto ONE session branch,
    // whose pull request names none of them. Its title carries no identifier at
    // all, which is exactly why the old one-card resolution left the rest behind.
    const sessionBranch = 'motir/auto-20260819-140000';
    for (const item of branchCards) {
      await transition(page, item.id, 'in_progress');
      await workItemsService.markIntegrated(item.id, sessionBranch, {
        userId: t.userId,
        workspaceId: t.workspaceId,
      });
      expect(await statusOnBoard(page, item.id)).toBe('implemented');
    }
    await showBoard(page, implementedColumn.id, branchCards[0]!.identifier);
    await beat();

    await deliverPr(page, {
      action: 'opened',
      number: 6102,
      title: 'Session run 20260819-140000 — 2 work items',
      headRef: sessionBranch,
      // No card is named by the pull request, so nothing to transition: the
      // cards were already at `implemented` when they joined the branch.
      expect: { event: 'pull_request', outcome: 'no_work_item' },
    });
    await deliverChecks(page, {
      conclusion: 'success',
      headSha: 'e2e-sha-6102',
      prNumber: 6102,
      headBranch: sessionBranch,
      expect: { event: 'ci' },
    });
    // ONE green promotes EVERY card the branch carries, not the one a link
    // column happens to name.
    for (const item of branchCards) {
      expect(await statusOnBoard(page, item.id)).toBe('in_review');
    }
    await showBoard(page, inReviewColumn.id, branchCards[0]!.identifier);
    await beat();

    await deliverPr(page, {
      action: 'closed',
      number: 6102,
      title: 'Session run 20260819-140000 — 2 work items',
      headRef: sessionBranch,
      merged: true,
      expect: { event: 'pull_request', outcome: 'session_closed' },
    });
    // EVERY card, not just one — the assertion the story's second half is.
    for (const item of branchCards) {
      expect(await statusOnBoard(page, item.id)).toBe('done');
    }
    await showBoard(page, doneColumn.id, branchCards[0]!.identifier);
    await expect(
      page
        .getByTestId(`board-column-${doneColumn.id}`)
        .getByTestId(`board-card-${branchCards[1]!.identifier}`),
    ).toBeVisible();
    await beat();
  });

  // ── 7 — the new column owes the same accessibility as the old ones ────────
  await chapter('The board with the new column passes a strict accessibility sweep', async () => {
    // Scoped to `color-contrast` for the reason `board-a11y.spec.ts` records:
    // that is the rule a new column's chrome and its chip can break, and the
    // full-page sweep over the whole shell is that spec's subject, not this
    // one's. The board here is the harder case — every column is occupied, so
    // the sweep sees the Implemented chip and its glyph, not an empty placeholder.
    const results = await new AxeBuilder({ page })
      .include('[data-testid="board"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const violations = results.violations.filter((v) => v.id === 'color-contrast');
    expect(
      violations,
      violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join('\n'),
    ).toEqual([]);
    await beat();
  });

  // The cards ended where the story says they end — read once more from the
  // projection, so the last thing this spec asserts is committed state.
  const finalBoard = await getBoard(page.request);
  expect(cardIdsIn(finalBoard, 'in_review')).toContain(card.id);
  for (const item of branchCards) expect(cardIdsIn(finalBoard, 'done')).toContain(item.id);
});
