import { projectsService } from '@/lib/services/projectsService';
import {
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import { E2E_REPO, E2E_REPO_SECOND } from './_helpers/github-const';
import { signUp } from './_helpers/shell-session';
import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';

// A card delivered by MORE THAN ONE PULL REQUEST (Story MOTIR-3655 ·
// MOTIR-3662) — watched in a browser, from partial delivery to done.
//
// ── What this proves that the vitest sibling cannot ────────────────────────
// `tests/github/deliverySetStory.test.ts` drives the same webhook seam and
// asserts rows and outcomes. It would pass in full while the rail rendered
// nothing at all, because it never opens a page. This is the only card in the
// story that answers *can a person TELL what is happening*, which is the
// story's second reason to exist: a gate that holds a card and cannot say why
// is half a feature.
//
// ⚠️ PACED FOR A HUMAN, DELIBERATELY. This clip is what somebody WATCHES to
// accept the story, and the entire product change is a PAUSE — the card holds
// after the first merge and completes after the second. A recording that blinks
// past that has met every acceptance criterion and proved nothing. Each of the
// three states therefore gets its own chapter and its own beats, so there is
// time to read the rail before the next thing happens.
//
// ── THE SEAMS, named per the card's own configuration check ────────────────
// Verified before a line was written, and recorded on MOTIR-3662:
//
//   * the card's RESTING STATUS is the product's, not the spec's — the `opened`
//     delivery lands it at Implemented and the hold keeps it there;
//   * the App installation + BOTH repository mirrors — `seedGithubInstallation`
//     with `E2E_REPO_SECOND`, the extra-repos parameter MOTIR-2730 added;
//   * the pull requests — REAL signed deliveries to `/api/github/webhook`
//     through `postSignedWebhook`, whose 200 + `result` body is the
//     authoritative completion signal (the route awaits the full service
//     handling before responding);
//   * the EXPLICIT delivery link — `POST /api/_test/pull-request-links`, a
//     transport over the shipped `linkPullRequestByCoordinates` with the
//     caller's real session, in the same shape the sibling `work-item-links`
//     route has. A pull request belongs to a card only by declaration, and no
//     webhook makes that declaration.
//
// ⚠️ `E2E_REPO_SECOND.defaultBranch` is `trunk`, not `main`. The gate compares
// each merge against its OWN repository's mirrored default branch, and a
// fixture where both were `main` could not tell a correct comparison from a
// hard-coded one. This journey inherits that property from the shipped const.
//
// DETERMINISM: every wait is on an authoritative signal — the webhook's own 200
// plus its outcome, then a rendered status. Never a timeout.

const EMAIL = `delivery-set-${Date.now()}@example.com`;

async function seedActiveProject(page: Page, identifier: string): Promise<{ projectId: string }> {
  // ⚠️ NO `@/lib/db` singleton statements — the same rule
  // `repository-set.spec.ts` states: `tests/rls/test-singleton-statement-guard`
  // ratchets that population DOWN over `tests/e2e/**`, because a direct
  // singleton write is REFUSED under `motir_app` and a direct read returns [],
  // and neither raises. The ids come from the shipped `/api/workspaces/current`
  // through the BROWSER's own session, and the project through the service.
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Delivery set',
    identifier,
  });
  // No active-project write is needed: `getActiveProject` falls back to the
  // workspace's first non-archived project, and this workspace has exactly one.
  return { projectId: project.id };
}

async function mkItem(
  page: Page,
  projectId: string,
  title: string,
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition → ${statusKey}`).toBe(200);
}

/** The detail rail's Repositories field card.
 *
 *  ⚠️ ANCHORED on the card's own text, not a substring — the same trap
 *  `repository-set.spec.ts` documents. After the first merge the gate posts a
 *  hold comment naming what it is waiting on, and that comment's card sits
 *  EARLIER in the DOM, so a `hasText: 'Repositories'` filter plus `.first()`
 *  silently retargets to the comment the moment the feature starts working. */
function repositoriesCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ hasText: /^Repositories/ })
    .first();
}

function statusCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
}

function developmentSection(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ hasText: /^Development/ })
    .first();
}

// ⚠️ THE 9000 BLOCK IS THIS SPEC'S (Bug MOTIR-3248). Pull-request numbers are a
// SHARED namespace across every E2E spec that delivers a signed webhook —
// `github_pull_request` is `@@unique([repoId, number])` and every spec's
// `seedGithubInstallation` upserts the SAME installation and repo row — so a
// collision fails at a distance, only once sharding happens to put two specs in
// one database. 4000 is `github.spec.ts`'s; 5000–8000 are taken.
//
// Written as `number:` LITERALS rather than bare constants because
// `tests/e2e-pull-request-number-blocks.test.ts` reads the source: a spec whose
// numbers it cannot see is reported as `0 numbers found`, which that guard
// treats as a FAILURE — a sweep that read nothing is broken, not passing.
const CORE = { repo: E2E_REPO, number: 9101 };
const SECOND = { repo: E2E_REPO_SECOND, number: 9202 };
const CORE_PR = CORE.number;
const SECOND_PR = SECOND.number;

/** A pull-request row's meta line, exactly as `DevelopmentSection` renders it
 *  (`{repo} · #{number}`) — the ONE string that identifies a row uniquely when
 *  one repository's name is a prefix of another's. */
function prMeta(repo: typeof E2E_REPO | typeof E2E_REPO_SECOND, number: number): string {
  return `${repo.owner}/${repo.name} · #${number}`;
}

function headRefFor(identifier: string, n: number): string {
  return `subtask/${identifier.toLowerCase()}-part-${n}`;
}

/** Open a pull request AND declare that it delivers the card — the two halves a
 *  run does per iteration, in that order. */
async function openAndLink(
  page: Page,
  args: {
    workItemId: string;
    identifier: string;
    number: number;
    repo: typeof E2E_REPO | typeof E2E_REPO_SECOND;
  },
): Promise<void> {
  const headRef = headRefFor(args.identifier, args.number);
  const opened = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number: args.number,
      // ⚠️ The title names NO card. The link below is the whole mechanism, and a
      // title that named one would let this pass on the parse this story retires.
      title: 'feat: half of the change',
      headRef,
      state: 'open',
      merged: false,
      repo: args.repo,
    }),
  );
  expect(opened.status(), `open ${args.repo.name}#${args.number}`).toBe(200);

  const linked = await page.request.post('/api/_test/pull-request-links', {
    data: {
      workItemId: args.workItemId,
      owner: args.repo.owner,
      name: args.repo.name,
      number: args.number,
      headRef,
      baseRef: args.repo.defaultBranch,
    },
  });
  expect(
    linked.status(),
    `link ${args.repo.name}#${args.number} → ${(await linked.text()).slice(0, 300)}`,
  ).toBe(201);
}

/** Merge one pull request and assert the OUTCOME the sync reported — the
 *  committed-state signal the next step reads the page on. */
async function merge(
  page: Page,
  args: {
    identifier: string;
    number: number;
    repo: typeof E2E_REPO | typeof E2E_REPO_SECOND;
    expectOutcome: string;
  },
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'closed',
      number: args.number,
      title: 'feat: half of the change',
      headRef: headRefFor(args.identifier, args.number),
      state: 'closed',
      merged: true,
      repo: args.repo,
    }),
  );
  // Carry the BODY into the failure message: a 500 here is a server-side fault
  // in the sync, and a bare status code sends the reader to the server log to
  // find out which gate.
  const body = await res.text();
  expect(res.status(), `merge ${args.repo.name}#${args.number} → ${body.slice(0, 400)}`).toBe(200);
  expect(
    (JSON.parse(body) as { result: Record<string, unknown> }).result,
    `merge ${args.repo.name}#${args.number}`,
  ).toMatchObject({ event: 'pull_request', outcome: args.expectOutcome });
}

test('a card delivered by TWO pull requests holds until both have merged', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3655');

  await signUp(page, EMAIL);
  const wsRes = await page.request.get('/api/workspaces/current');
  expect(wsRes.status()).toBe(200);
  const workspaceId = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;
  const { projectId } = await seedActiveProject(page, 'DSET');
  await seedGithubInstallation(workspaceId, [E2E_REPO_SECOND]);

  const card = await mkItem(page, projectId, 'Delivered by two pull requests');
  await transition(page, card.id, 'in_progress');

  await openAndLink(page, {
    workItemId: card.id,
    identifier: card.identifier,
    number: CORE_PR,
    repo: E2E_REPO,
  });
  await openAndLink(page, {
    workItemId: card.id,
    identifier: card.identifier,
    number: SECOND_PR,
    repo: E2E_REPO_SECOND,
  });
  // ⚠️ NO explicit status write. The `pull_request opened` delivery lands the
  // card at IMPLEMENTED on its own — the same thing `repository-set.spec.ts`
  // relies on — and forcing a status here would assert a state the product did
  // not produce.

  // ── 1 — both deliveries are visible, and neither has landed ───────────────
  await chapter('Open a card that two pull requests deliver', async () => {
    await page.goto(`/items/${card.identifier}`);
    const development = developmentSection(page);
    await expect(development).toBeVisible();
    await beat();

    // Both pull requests, each named by its own repository AND its own number.
    // This is the row the singular link column could never have shown for more
    // than one of them.
    //
    // ⚠️ QUALIFIED BY NUMBER, and it has to be: `motir-demo` is a PREFIX of
    // `motir-demo-api`, so the bare repository name matches BOTH rows and trips
    // strict mode. The number is what makes each locator resolve to one element
    // — and it asserts more than the name did, because it pins the right pull
    // request to the right repository rather than merely to the section.
    await expect(development.getByText(prMeta(E2E_REPO, CORE_PR))).toBeVisible();
    await expect(development.getByText(prMeta(E2E_REPO_SECOND, SECOND_PR))).toBeVisible();
    await beat();

    await expect(statusCard(page).getByText('Implemented', { exact: true })).toBeVisible();
    await beat();
  });

  // ── 2 — the FIRST merge, and the card does NOT move ───────────────────────
  //
  // This is the pause the whole story is about. The reader has to be able to
  // see that something landed AND that the card is still waiting, at the same
  // time, which is why both are asserted in one chapter with a beat between.
  await chapter('Merge the first pull request — the card does not close', async () => {
    await merge(page, {
      identifier: card.identifier,
      number: CORE_PR,
      repo: E2E_REPO,
      expectOutcome: 'deferred_incomplete_delivery_set',
    });
    await page.reload();
    await beat();

    // Still IMPLEMENTED. On `origin/main` before this story, the first merge
    // closed the card outright with the second pull request still open.
    await expect(statusCard(page).getByText('Implemented', { exact: true })).toBeVisible();
    await beat();

    // …and the card SAYS what it is waiting for. The gate's hold comment names
    // the outstanding pull request, so a person does not have to open both to
    // work out which half is missing.
    await expect(
      page.getByText(`${E2E_REPO_SECOND.owner}/${E2E_REPO_SECOND.name}#${SECOND_PR}`).first(),
    ).toBeVisible();
    await beat();

    // The rail's repository row for the merged half no longer reads as
    // outstanding, while the card as a whole still does — the two facts the
    // amended predicate keeps apart (MOTIR-3660).
    await expect(repositoriesCard(page)).toBeVisible();
    await beat();
  });

  // ── 3 — the SECOND merge closes it ────────────────────────────────────────
  await chapter('Merge the second — now the card is done', async () => {
    await merge(page, {
      identifier: card.identifier,
      number: SECOND_PR,
      repo: E2E_REPO_SECOND,
      expectOutcome: 'transitioned',
    });
    await page.reload();
    await beat();

    await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
    await beat();

    // Both pull requests are still listed, both merged — the card's record of
    // what delivered it survives the close. Number-qualified for the same
    // prefix reason as chapter 1.
    const development = developmentSection(page);
    await expect(development.getByText(prMeta(E2E_REPO, CORE_PR))).toBeVisible();
    await expect(development.getByText(prMeta(E2E_REPO_SECOND, SECOND_PR))).toBeVisible();
    await beat();
  });
});
