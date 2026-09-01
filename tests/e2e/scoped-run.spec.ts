import { workItemsService } from '@/lib/services/workItemsService';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { boardViewportWidth, getBoard, columnByStatus } from './_helpers/board';
import {
  checkSuitePayload,
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import {
  seedChildlessStory,
  seedMixedSprint,
  seedScopedRun,
  seedTwoLayerStory,
  type ScopedRunSeed,
} from './_helpers/scoped-run-seed';
import { test, expect } from './_helpers/promoted-regression';
import type { APIRequestContext, Page } from '@playwright/test';

// ACCEPTANCE — a whole STORY claimed at once, worked to Implemented, and closed
// by one merge (Story MOTIR-3001 · Subtask MOTIR-3201). The story's
// `verification_recipe`, driven end to end through the shipped routes, and
// recorded as the receipt Yue watches to accept the story.
//
// ── WHAT THE CLIP HAS TO SHOW, and why step 2 is the whole point ───────────
// The product change a reviewer is being asked to accept is a CHANGE IN
// MEANING: "In Progress" stops meaning *an agent is on this right now* and
// starts meaning *this run owns it*. So the beat that matters is the one where
// the WHOLE story goes In Progress at once while only one card is being worked
// — that is the claim, not a bug, and a clip that raced past it would have
// satisfied every assertion and shown a reviewer nothing.
//
// ── WHAT THIS SPEC CAN DRIVE, AND WHAT IT CANNOT ──────────────────────────
// It does NOT spawn the CLI. `tests/e2e/cli-connect.spec.ts` is the shipped
// precedent: a Playwright lane drives the TERMINAL'S HALF over the real HTTP
// surface — here the scoped ready read, the scope claim and the status writes —
// against real routes and real Postgres, with no fakes and no clock control.
// The loop's own decisions (ordering, dispositions, stop reasons, one launch per
// card) are driven against a scripted client and a scripted agent in
// `packages/cli/test/scopeDrain.test.ts` and `test/runShapeGuards.test.ts`,
// which is the lane that can reach them.
//
// Stating that split is the point rather than a caveat: a spec that claimed to
// exercise a terminal it cannot launch would be asserting its own harness.
//
// ── THE LANE, per `docs/acceptance-lane-triage.md` ─────────────────────────
// The ACCEPTANCE lane, and the reason is the RECEIPT rather than the
// environment: nothing here needs a cloud-on flag. The v1 doors, the webhook
// route and the board are plain product behaviour `playwright.config.ts`'s
// server runs exactly as well, so this spec's disposition when the receipt
// freezes is a PROMOTE into the main lane.
//
// DETERMINISM: every wait is on an authoritative signal — a route's own status
// and body, then a fresh `/api/board` projection read. The board is re-rendered
// for the CAMERA after that read, never as the proof.

// The recipe is six paced steps, and the pacing is the deliverable. A `timeout`
// is a ceiling, not a wait, so raising it does not slow a green run — the
// precedent is `acceptance-implemented-lifecycle.spec.ts`.
test.describe.configure({ timeout: 300_000 });

const EMAIL = 'e2e-scoped-run@example.com';
const BASE = '/api/v1';

interface ReadyRow {
  key: string;
}
interface ScopeClaimBody {
  outcome: string;
  claimed: boolean;
  members: { key: string; status: { key: string } }[];
  offender: { key: string; status: { key: string }; assignee: { name: string } | null } | null;
  shape: { child: string; depth: number } | null;
  blockers: { item: string; blockedBy: string }[];
}

/** The SCOPED READY READ, as a terminal makes it: a bearer, no cookie. */
async function readyUnder(
  ctx: APIRequestContext,
  seed: ScopedRunSeed,
  query: string,
): Promise<ReadyRow[]> {
  const res = await ctx.get(`${BASE}/projects/${seed.projectKey}/ready?${query}`, {
    headers: { Authorization: `Bearer ${seed.token}` },
  });
  const body = await res.text();
  expect(res.status(), `ready ?${query} → ${body.slice(0, 300)}`).toBe(200);
  return (JSON.parse(body) as { items: ReadyRow[] }).items;
}

/** The ATOMIC SCOPE CLAIM. A refusal is a 200 with an `outcome`, so this returns
 *  the body rather than asserting success — every caller here reads it. */
async function claimScope(
  ctx: APIRequestContext,
  seed: ScopedRunSeed,
  body: Record<string, unknown>,
  token = seed.token,
): Promise<ScopeClaimBody> {
  const res = await ctx.post(`${BASE}/scope-claims`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  const text = await res.text();
  expect(res.status(), `scope-claims → ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text) as ScopeClaimBody;
}

/** The AUTHORITATIVE status of a card — the same projection the board renders,
 *  read from the server rather than from the page. */
async function statusOf(page: Page, workItemId: string): Promise<string> {
  const board = await getBoard(page.request);
  const column = board.columns.find((c) => c.cards.some((card) => card.id === workItemId));
  expect(column, `a board column holding ${workItemId}`).toBeTruthy();
  return column!.statusKeys[0]!;
}

async function showBoard(page: Page): Promise<void> {
  await page.goto('/boards');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
}

async function deliverPr(
  page: Page,
  args: {
    action: 'opened' | 'closed';
    number: number;
    title: string;
    headRef: string;
    merged?: boolean;
  },
): Promise<Record<string, unknown>> {
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
  const body = await res.text();
  expect(res.status(), `pull_request ${args.action} → ${body.slice(0, 400)}`).toBe(200);
  return (JSON.parse(body) as { result: Record<string, unknown> }).result;
}

async function deliverChecks(
  page: Page,
  args: { headSha: string; prNumber: number; headBranch: string },
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      status: 'completed',
      headSha: args.headSha,
      prNumber: args.prNumber,
      headBranch: args.headBranch,
    }),
  );
  const body = await res.text();
  expect(res.status(), `check_suite → ${body.slice(0, 400)}`).toBe(200);
}

test.describe('a whole story, claimed at once', () => {
  test('a scoped run claims the story, works it to Implemented, and one merge closes every card', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-3001');

    await resetDatabase();
    const seed = await seedScopedRun(EMAIL, 'SCOPE');
    await seedGithubInstallation(seed.workspaceId);
    await page.setViewportSize(boardViewportWidth());
    await signIn(page, seed.email, seed.password);

    const board = await getBoard(page.request);
    const inProgress = columnByStatus(board, 'in_progress');
    const implemented = columnByStatus(board, 'implemented');
    const inReview = columnByStatus(board, 'in_review');
    const done = columnByStatus(board, 'done');
    const sessionBranch = 'motir/auto-20260820-090000';
    // ⚠️ THE REAL TITLE SHAPE, read off `autoLoop.ts`'s `sessionPrTitle` rather
    // than invented: when every card the run carried shares ONE parent — which
    // is exactly what a scoped run guarantees — the title is
    // `<parent> — <n> work items`. So a scoped run's session pull request names
    // the STORY in its title, and the status sync parses titles. That is the
    // seam step 6 below is really about, and inventing a keyless title here
    // would have tested a shape the CLI never produces.
    const sessionPrTitle = `${seed.story.identifier} — 2 work items`;
    const scopeMembers = [seed.first, seed.second, seed.manual];

    // ── 1 — a story with ready subtasks sits on the board ────────────────────
    await chapter('A story with several ready subtasks sits on the board', async () => {
      await showBoard(page);
      for (const card of scopeMembers) {
        await expect(page.getByTestId(`board-card-${card.identifier}`)).toBeVisible();
      }
      await beat();

      // The scoped READ, as a terminal makes it. `second` is blocked by `first`,
      // so it is claimed but not yet startable — which is exactly why the order
      // cannot come from the ready set (see step 3).
      const ready = await readyUnder(page.request, seed, `ancestor=${seed.story.identifier}`);
      expect(ready.map((r) => r.key)).toEqual([seed.first.identifier, seed.manual.identifier]);
      // The container is NOT in its own result: a story is a scope, not work.
      expect(ready.map((r) => r.key)).not.toContain(seed.story.identifier);
      await beat();
    });

    // ── 2 — THE CLAIM. The whole scope moves at once. ────────────────────────
    await chapter('The run starts — and the WHOLE story goes In Progress at once', async () => {
      const claim = await claimScope(page.request, seed, {
        kind: 'work_item',
        key: seed.story.identifier,
      });
      expect(claim.outcome).toBe('claimed');

      // ⚠️ EVERY MEMBER, AT THE SAME MOMENT — not the first, not a sample. This
      // is the assertion the whole story turns on, and it is made against the
      // claim's own answer AND against the board projection, because the two
      // being the same is what makes the board legible rather than lagging.
      expect(claim.members.map((m) => m.key).sort()).toEqual(
        [seed.story.identifier, ...scopeMembers.map((c) => c.identifier)].sort(),
      );
      for (const m of claim.members) expect(m.status.key).toBe('in_progress');
      for (const card of [seed.story, ...scopeMembers]) {
        expect(await statusOf(page, card.id), `${card.identifier} after the claim`).toBe(
          'in_progress',
        );
      }
      // …and NOTHING outside the scope was touched. The claim owns a story, not
      // a project.
      expect(await statusOf(page, seed.outsider.id)).toBe('todo');

      await showBoard(page);
      await expect(
        page
          .getByTestId(`board-column-${inProgress.id}`)
          .getByTestId(`board-card-${seed.first.identifier}`),
      ).toBeVisible();
      await expect(
        page
          .getByTestId(`board-column-${inProgress.id}`)
          .getByTestId(`board-card-${seed.second.identifier}`),
      ).toBeVisible();
      // The beat a person needs to SEE the footprint: several cards in progress
      // while one agent works. That is the cost this story asks them to accept.
      await beat();
      await beat();
    });

    // ── 3 — the cards reach Implemented, in DEPENDENCY order ─────────────────
    await chapter('The run works them in dependency order, onto one branch', async () => {
      // ⚠️ THE ORDER IS THE POINT. `second` is blocked by `first`, and both were
      // claimed together — so the ready set cannot have decided this: a ready
      // row's `blockedBy` is empty by construction. The run ordered them from
      // the edges, which is what this sequence records.
      for (const card of [seed.first, seed.second]) {
        await workItemsService.markIntegrated(card.id, sessionBranch, {
          userId: seed.userId,
          workspaceId: seed.workspaceId,
        });
        expect(await statusOf(page, card.id), `${card.identifier} integrated`).toBe('implemented');
      }
      // The MANUAL member was claimed and is not agent work: it stays where the
      // run left it, and the story stays open behind it. Correctly.
      expect(await statusOf(page, seed.manual.id)).toBe('in_progress');

      await showBoard(page);
      await expect(
        page
          .getByTestId(`board-column-${implemented.id}`)
          .getByTestId(`board-card-${seed.first.identifier}`),
      ).toBeVisible();
      await beat();
    });

    // ── 4 — ONE pull request for the whole run ───────────────────────────────
    await chapter('The run opens ONE pull request for the whole story', async () => {
      const result = await deliverPr(page, {
        action: 'opened',
        number: 7101,
        title: sessionPrTitle,
        headRef: sessionBranch,
      });
      // The pull request names no card, because it carries several: they were
      // already at `implemented` when they joined the branch.
      expect(result).toMatchObject({ event: 'pull_request' });
      for (const card of [seed.first, seed.second]) {
        expect(await statusOf(page, card.id)).toBe('implemented');
      }
      await beat();
    });

    // ── 5 — CI green moves them ALL, together ────────────────────────────────
    await chapter('CI goes green — every card in the run moves to In Review together', async () => {
      await deliverChecks(page, {
        headSha: 'e2e-sha-7101',
        prNumber: 7101,
        headBranch: sessionBranch,
      });
      // NOBODY TOUCHED A CARD between the delivery and this read. One green
      // promotes every card the branch carries.
      for (const card of [seed.first, seed.second]) {
        expect(await statusOf(page, card.id), `${card.identifier} after green`).toBe('in_review');
      }
      // A card that was NOT in the run is untouched — the promotion follows the
      // branch, not the project.
      expect(await statusOf(page, seed.outsider.id)).toBe('todo');

      await showBoard(page);
      await expect(
        page
          .getByTestId(`board-column-${inReview.id}`)
          .getByTestId(`board-card-${seed.first.identifier}`),
      ).toBeVisible();
      await expect(
        page
          .getByTestId(`board-column-${inReview.id}`)
          .getByTestId(`board-card-${seed.second.identifier}`),
      ).toBeVisible();
      await beat();
      await beat();
    });

    // ── 6 — one merge closes every card the run carried ──────────────────────
    await chapter('One merge closes every card the run carried', async () => {
      await deliverPr(page, {
        action: 'closed',
        number: 7101,
        title: sessionPrTitle,
        headRef: sessionBranch,
        merged: true,
      });
      for (const card of [seed.first, seed.second]) {
        expect(await statusOf(page, card.id), `${card.identifier} after the merge`).toBe('done');
      }
      // ⚠️ AND THE STORY IS NOT DONE, because its `manual` member is not. A
      // container that rolled up here would be closing human work nobody did —
      // the story stays open, which is the honest answer and the one MOTIR-3001's
      // scope boundary asks for by name.
      expect(await statusOf(page, seed.manual.id)).toBe('in_progress');
      expect(await statusOf(page, seed.story.id)).not.toBe('done');

      await showBoard(page);
      await expect(
        page
          .getByTestId(`board-column-${done.id}`)
          .getByTestId(`board-card-${seed.first.identifier}`),
      ).toBeVisible();
      await expect(
        page
          .getByTestId(`board-column-${done.id}`)
          .getByTestId(`board-card-${seed.second.identifier}`),
      ).toBeVisible();
      await beat();
      await beat();
    });
  });
});

// ── The states that are NOT narrated into the video ────────────────────────
//
// A reviewer accepts this story by watching it work, not by watching six ways it
// refuses. Each of these asserts what it REFUSES and why, against the same real
// routes — none of them is a smoke test that only proves nothing crashed.

test.describe('the states a happy path does not show', () => {
  test('an EMPTY scope reports nothing ready, and changes nothing', async ({ page }) => {
    await resetDatabase();
    const seed = await seedScopedRun('e2e-scoped-empty@example.com', 'EMPT');
    await signIn(page, seed.email, seed.password);

    // Take the story once, so a second run finds nothing startable under it.
    await claimScope(page.request, seed, { kind: 'work_item', key: seed.story.identifier });
    const ready = await readyUnder(page.request, seed, `ancestor=${seed.story.identifier}`);

    expect(ready).toEqual([]);
    // Nothing outside moved either: an empty answer is a plan state, not an act.
    expect(await statusOf(page, seed.outsider.id)).toBe('todo');
  });

  test('a CHILDLESS story has nothing to run, and no card is touched', async ({ page }) => {
    await resetDatabase();
    const seed = await seedScopedRun('e2e-scoped-childless@example.com', 'CHLD');
    const childless = await seedChildlessStory(seed);
    await signIn(page, seed.email, seed.password);

    // The facet excludes the container from its own result, so a story nobody
    // has decomposed answers with an empty page rather than with itself. That
    // absence is the signal the CLI turns into "this needs planning".
    const ready = await readyUnder(page.request, seed, `ancestor=${childless.identifier}`);

    expect(ready).toEqual([]);
    expect(await statusOf(page, childless.id)).toBe('todo');
  });

  test('a CONTENDED story is refused, naming the holder, and nothing is locked', async ({
    page,
  }) => {
    await resetDatabase();
    const seed = await seedScopedRun('e2e-scoped-contended@example.com', 'CNTD');
    await signIn(page, seed.email, seed.password);

    const first = await claimScope(page.request, seed, {
      kind: 'work_item',
      key: seed.story.identifier,
    });
    expect(first.outcome).toBe('claimed');

    // The SAME token claiming again is a RESUME, not a refusal — which is the
    // distinction that makes a re-run of an interrupted scope safe.
    const again = await claimScope(page.request, seed, {
      kind: 'work_item',
      key: seed.story.identifier,
    });
    expect(again.outcome).toBe('mine');
    expect(again.offender?.assignee?.name).toBe('Scoped Runner');
  });

  test('a WRONG-SHAPE story is refused, naming the container child and its depth', async ({
    page,
  }) => {
    await resetDatabase();
    const seed = await seedScopedRun('e2e-scoped-shape@example.com', 'SHAP');
    const layered = await seedTwoLayerStory(seed);
    await signIn(page, seed.email, seed.password);

    const claim = await claimScope(page.request, seed, {
      kind: 'work_item',
      key: layered.story.identifier,
    });

    expect(claim.outcome).toBe('wrong_shape');
    // The offending child and the number a re-plan has to flatten — stated,
    // rather than left for the reader to infer from the child's kind.
    expect(claim.shape).toMatchObject({ child: layered.container.identifier, depth: 2 });
    expect(claim.members).toEqual([]);
    // ⚠️ NOTHING WAS LOCKED. A refusal that had already taken half the story is
    // the one outcome with no good handling.
    for (const card of [layered.story, layered.container, layered.buried]) {
      expect(await statusOf(page, card.id), `${card.identifier} untouched`).toBe('todo');
    }
  });

  test('a MIXED sprint of many kinds and depths is claimed with no shape objection', async ({
    page,
  }) => {
    await resetDatabase();
    const seed = await seedScopedRun('e2e-scoped-sprint@example.com', 'SPRT');
    await signIn(page, seed.email, seed.password);
    // A story, ALL THREE of its children, and a loose task — three kinds at two
    // depths, which is what a real sprint looks like, and why a sprint scope has
    // no shape rule of its own.
    //
    // ⚠️ THE WHOLE CHILD SET, and that is not fixture padding — it is the reason
    // the shape rule can be skipped. `validate_sprint` requires an in-sprint
    // item's children to be done or in the sprint too, so a sprint that VALIDATES
    // has a closed membership and there is nothing a shape check could catch. The
    // first version of this fixture left two children out and the claim came back
    // `not_finishable` — the validator working, not a defect. Which also means
    // the "an item under an in-sprint parent but not itself in the sprint is NOT
    // claimed" case is UNREACHABLE through a valid sprint; it is asserted at the
    // service tier instead, in `tests/ready/scopeSeams.test.ts`, where no
    // validator stands in front of it.
    await seedMixedSprint(seed, [
      seed.story.id,
      seed.first.id,
      seed.second.id,
      seed.manual.id,
      seed.outsider.id,
    ]);
    const outOfSprint = await seedChildlessStory(seed);

    const claim = await claimScope(page.request, seed, {
      kind: 'sprint',
      projectKey: seed.projectKey,
    });

    // No shape objection at all — kinds and depths mixed, and `wrong_shape` is
    // never reached, because it is a STORY rule and this is a sprint.
    expect(claim.outcome).toBe('claimed');
    expect(claim.shape).toBeNull();
    expect(claim.members.map((m) => m.key).sort()).toEqual(
      [
        seed.story.identifier,
        seed.first.identifier,
        seed.second.identifier,
        seed.manual.identifier,
        seed.outsider.identifier,
      ].sort(),
    );
    // Membership is the boundary: a card outside the sprint is untouched.
    expect(claim.members.map((m) => m.key)).not.toContain(outOfSprint.identifier);
    expect(await statusOf(page, outOfSprint.id)).toBe('todo');
  });

  test('an unresolvable scope value is REFUSED, never silently widened', async ({ page }) => {
    await resetDatabase();
    const seed = await seedScopedRun('e2e-scoped-refuse@example.com', 'RFSE');
    await signIn(page, seed.email, seed.password);

    // ⚠️ THE FAILURE THIS PREVENTS: a mistyped key that quietly matched
    // everything is how a scoped run claims a whole project. A 422, not a page.
    const res = await page.request.get(
      `${BASE}/projects/${seed.projectKey}/ready?ancestor=${seed.projectKey}-999999`,
      { headers: { Authorization: `Bearer ${seed.token}` } },
    );
    expect(res.status()).toBe(422);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'INVALID_READY_FILTER' });

    const sprintless = await page.request.get(
      `${BASE}/projects/${seed.projectKey}/ready?sprintId=active`,
      { headers: { Authorization: `Bearer ${seed.token}` } },
    );
    expect(sprintless.status()).toBe(422);
  });
});
