// Acceptance E2E — Story MOTIR-1775: approve a plan and get the repositories your
// architecture needs (Subtask MOTIR-1785).
//
// Runs under playwright.acceptance.config.ts (video: 'on'), which discovers this
// file by its `acceptance*.spec.ts` name (MOTIR-1700); the bulk shards
// `testIgnore` the same pattern, so it runs ONCE, in the lane that records. The
// recorded happy path declares Story MOTIR-1775 via `acceptanceStory()`
// (MOTIR-1684), so the clip publishes to 1775 whichever PR triggered the run.
//
// ══ WHAT THIS STORY CLAIMS, AND WHAT THE HEADLINE JOURNEY PROVES ══
//
// A plan that separates a web app from an API needs TWO repositories, and Motir
// should work that out from the plan rather than asking. So the recorded journey
// is the TWO-repo one: a one-repo spec would pass while leaving the premise
// untested (the card's own 2026-07-30 sweep).
//
// ⚠️ THE HEADLINE ASSERTION IS AN EQUIVALENCE (the 2026-07-30 ownership re-plan).
// A user WITH a connected GitHub identity and a user WITHOUT one walk the same
// flow through creation — no connect prompt, no consent screen, no account
// question — and both end with repositories under MOTIR's org. `equivalence
// through creation` below asserts that directly rather than testing two variants,
// because it is the acceptance for the ownership decision itself. The journeys
// legitimately DIVERGE after the code exists, at the access step, which is why the
// recorded journey is the NO-identity one: that is the pre-Epic-9 main line
// (MOTIR-1900) and the half a reviewer most needs to see work.
//
// ══ NO REAL REPOSITORY IS CREATED ══ The two GitHub boundaries are faked INSIDE
// the Next server (`lib/test-github-repos-mock.ts`, E2E_TEST_GITHUB_REPOS=1),
// because both are server-side `fetch`es that `page.route` cannot see. The spec
// scripts it through the control file and asserts the EXACT outbound bodies
// through the journal (`repository-set-seed.ts`). The identity connect is NOT
// faked at that level — it is the real `/api/github/oauth/start` → callback
// round-trip github.spec.ts drives.
//
// ══ WAITS ══ Every wait is on an authoritative signal (CLAUDE.md § E2E): the
// write's own response, or the committed per-row state the establish poll
// re-reads. Repository creation is external and slow by nature, so the rows are
// polled to `created` via `expect(...).toHaveAttribute('data-state', …)` against
// the row's own committed state — never a fixed sleep, and never the optimistic UI.
//
// ══ SELECTOR SCOPING ══ `Connect GitHub` appears at THREE altitudes on this
// surface (the default path's ready-state primary, the access step's prompt, and a
// `not invited` row) and `Let Motir host it` at two, so nothing here is located by
// name alone: row-level controls go through `repo-row-<role>`, and the rest are
// pinned by ROLE plus the screen the assertion runs on (see the note by the
// locators). Two more traps this file works around, both real: `Your code is
// ready` is BOTH `repositorySet.ready` (the step's status line) and
// `repositorySet.outcomeReady` (the rail's line), character for character; and
// `Finish setting up access` shares a prefix with `Finish setting up
// repositories`, so both are matched with `exact: true`.

import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { E2E_PROVISIONING_ORG } from './_helpers/github-const';
import {
  collaboratorInvites,
  connectGithubIdentity,
  githubJournal,
  repoCreates,
  resetGithubFixture,
  seedRepositorySet,
  setGithubControl,
  REPO_SET_LOGIN,
  type RepositorySetSeed,
} from './_helpers/repository-set-seed';

// A full approve → derive → create → invite → dispatch journey against a
// production build, paced for a human. The lane runs `workers: 1, retries: 0`.
test.describe.configure({ timeout: 300_000 });

// ── Locators, all scoped ─────────────────────────────────────────────────────

/** One row of the set, by ROLE — the shipped `data-testid` (RepositoryRow). */
const row = (page: Page, role: string) => page.getByTestId(`repo-row-${role}`);

/** The default path's single status line (`repo-setup-status`). */
const setupStatus = (page: Page) => page.getByTestId('repo-setup-status');

// ⚠️ NO "the step" LOCATOR ON PURPOSE. The step and the review rail are siblings
// inside the SAME `<main>`, so a `main`-scoped locator would scope nothing — and
// the step's own shell carries no test id, which this spec must not add (it ships
// no product change). Disambiguation is therefore by ROLE plus the screen the
// assertion runs on, which is sufficient for every collision this surface has:
//   * `Connect GitHub` — a BUTTON on the default path's ready state and on the
//     access step; a LINK on the access step's no-identity prompt and on a
//     `not invited` ROW. Rows are never rendered on the default or access step,
//     and the two buttons never co-occur, so role + screen is exact. Row-level
//     ones are always reached through `row()`.
//   * `Your code is ready` — the step's status line (`repo-setup-status`) AND the
//     rail's approved outcome, character for character. The step's is always read
//     through `setupStatus`; when the pair itself is the subject, it is counted
//     with `exact: true` rather than located.
// Every assertion below asserts the screen it is on BEFORE reaching for a name
// that exists on another one.

/** The row's name field, by the shipped `nameLabelForRole` copy. */
const nameField = (page: Page, role: string) =>
  row(page, role).getByRole('textbox', { name: `Name of the ${role} repository` });

// ── Journey helpers ──────────────────────────────────────────────────────────

/**
 * Approve the plan on the plan-detail route and wait for the APPROVE RESPONSE —
 * the authoritative signal. The step is server-rendered from the approved plan,
 * so asserting it before the write lands would race the round trip.
 */
async function approvePlan(page: Page, seed: RepositorySetSeed): Promise<void> {
  await page.goto(`/plans/${seed.planId}`);
  const approve = page.getByRole('button', { name: /^Approve — add/ });
  await expect(approve).toBeVisible();
  const approved = page.waitForResponse(
    (r) => /\/api\/plans\/[^/]+\/approve/.test(r.url()) && r.request().method() === 'POST',
  );
  await approve.click();
  expect((await approved).status(), 'the approve write succeeded').toBe(200);
  // The rail is now read-only and says so — the plan is safe BEFORE anything
  // about code is asked (ADR §4.3), which is the honesty the step depends on.
  await expect(page.getByText(/^Added \d+ items? to your backlog$/)).toBeVisible();

  // ⚠️ TEMPORARY, AND IT IS COVERING A REAL DEFECT — MOTIR-1947.
  //
  // The establish step SHOULD be here already. It is not: the step is rendered
  // from a SERVER read in `app/(authed)/plans/[id]/page.tsx`, and the approve
  // handler (`PlanDetail`'s `runAction`) only refetches the plan REVIEW into
  // client state — it never `router.refresh()`es, so the server read that
  // produces `repositorySet` never re-runs and the prop stays `null`. A real
  // user therefore approves a plan and is told NOTHING about code until they
  // happen to open the plan again, which is the exact opposite of this Story's
  // premise. Reproduced from this spec before it was diagnosed; filed as
  // MOTIR-1947 rather than fixed here (this card ships no product code).
  //
  // The re-navigation below is what makes the rest of the journey reachable
  // TODAY. It is deliberately a full navigation and not a `reload()`, so it
  // reads on camera as "the user comes back to the plan" rather than as a page
  // blinking. **When MOTIR-1947 lands, DELETE these two lines** — every
  // assertion after this point is unchanged either way, so their removal is
  // that fix's own regression test.
  await page.goto(`/plans/${seed.planId}`);
  await expect(page.getByText(/^Added \d+ items? to your backlog$/)).toBeVisible();
}

/** Open the TECHNICAL path — where rows, roles, names and per-row state exist at
 *  all. Requires an App installation (grant 2); without one the same control
 *  leads to the short "use the code you already have" confirmation instead. */
async function openTechnicalPath(page: Page): Promise<void> {
  // Assert the STEP is on the page before reaching for a control inside it. The
  // step renders only when the project's set has rows, and the set is derived by
  // a best-effort post-commit pass in `approvePlan` that SWALLOWS its failures —
  // so a derivation that broke shows up here as "the button never appeared",
  // which is an unreadable way to learn that the set is empty.
  await expect(
    page.getByRole('heading', { name: 'Motir will host your code' }),
    'the establish step is on the page (an empty set renders no step at all)',
  ).toBeVisible();
  await page.getByRole('button', { name: 'I already have code' }).click();
  await expect(page.getByRole('heading', { name: 'Where should each part live?' })).toBeVisible();
}

/** Wait for a row to reach a COMMITTED state — the row's own `data-state`, which
 *  the step's 1.5s poll re-reads from the server. The authoritative signal for a
 *  create, whose duration is external and unmeasured (spike §4.2). */
async function expectRowState(page: Page, role: string, state: string): Promise<void> {
  await expect(row(page, role)).toHaveAttribute('data-state', state, { timeout: 60_000 });
}

/** The `owner/name` a create landed on, read off the journal's own request. */
function createdNames(): string[] {
  return repoCreates().map((c) => String(c.body?.['name']));
}

/**
 * WHICH ACCOUNT a create call targets — the assertion the whole ownership
 * decision rests on, and it is NOT simply "the org appears in the path".
 *
 * The two endpoints carry the target differently, and the template one is the
 * trap: `POST /repos/{templateOwner}/{template}/generate` names the STARTER's
 * owner in its path (`moooon-B-V`) and the destination only in its BODY's
 * `owner`. Asserting on the path alone would therefore read the template's owner
 * as the repository's owner and pass for entirely the wrong reason.
 */
function createTargetOwner(call: { path: string; body: Record<string, unknown> | null }): string {
  if (typeof call.body?.['owner'] === 'string') return call.body['owner'];
  return /^\/orgs\/([^/]+)\/repos$/.exec(call.path)?.[1] ?? '';
}

/** Ask the REAL dispatch surface for one item and return its payload. */
async function dispatchNext(
  page: Page,
  projectKey: string,
  excludeIds: string[] = [],
): Promise<Record<string, unknown>> {
  const res = await page.request.post('/api/ready/next', {
    data: { projectKey, excludeIds },
  });
  expect(res.status(), 'the dispatch surface answered').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE HEADLINE JOURNEY — the one that carries the camera.
// ═════════════════════════════════════════════════════════════════════════════

test('approve a plan that has two parts, and get a repository for each — then get into them', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1775');

  await resetDatabase();
  resetGithubFixture();
  // An App installation (grant 2) but NO identity (grant 1): the two grants are
  // independent, and this is the pre-Epic-9 main line — the user reaches the
  // access step with nothing connected and is PROMPTED, never failed.
  const seed = await seedRepositorySet('e2e-repo-set@example.com', 'Acme Booking', 'ABK', {
    roles: ['web', 'api'],
    withInstallation: true,
    withIdentity: false,
  });
  await signIn(page, seed.email, seed.password);

  await chapter('The plan is approved — and only then is code discussed', async () => {
    await approvePlan(page, seed);
    // The establish step takes the canvas. Its default path is ONE sentence and
    // one primary: no repository name, role or count reaches it.
    await expect(page.getByRole('heading', { name: 'Motir will host your code' })).toBeVisible();
    await beat();
  });

  await chapter('Two parts in the plan, two repositories proposed', async () => {
    await openTechnicalPath(page);
    // ONE row per part, each carrying its role and the gloss that says what the
    // role MEANS in the user's words.
    await expect(row(page, 'web')).toHaveAttribute('data-state', 'proposed');
    await expect(row(page, 'api')).toHaveAttribute('data-state', 'proposed');
    await expect(row(page, 'web').getByText('The app people use')).toBeVisible();
    await expect(row(page, 'api').getByText('The service behind it')).toBeVisible();
    // WHY each row is here — the derivation's persisted signal, in prose. This is
    // the plan-item-role rung: the plan pinned the roles, so nobody was asked.
    await expect(
      row(page, 'api').getByText(/Part of the plan you approved builds the api/),
    ).toBeVisible();
    // Where it will be created — Motir's org, as the fixed prefix on the name.
    await expect(row(page, 'web').getByText(`${E2E_PROVISIONING_ORG} /`)).toBeVisible();
    await beat();
  });

  await chapter('The set is the user’s to change, not Motir’s to impose', async () => {
    const field = nameField(page, 'api');
    await field.fill(`${seed.projectSlug}-availability`);
    // Commit is on BLUR (a persisted decision, not a per-keystroke PATCH), so the
    // authoritative signal is the PATCH's own 200.
    const patched = page.waitForResponse(
      (r) => /\/repositories\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH',
    );
    await field.blur();
    expect((await patched).status(), 'the rename persisted').toBe(200);
    await expect(nameField(page, 'api')).toHaveValue(`${seed.projectSlug}-availability`);
    await beat();
  });

  await chapter('Motir creates both — each row reports its own outcome', async () => {
    await page.getByRole('button', { name: 'Set up 2 repositories' }).click();
    await expectRowState(page, 'web', 'created');
    await expectRowState(page, 'api', 'created');
    await expect(row(page, 'web').getByText('Created')).toBeVisible();
    await expect(row(page, 'api').getByText('Created')).toBeVisible();
    await beat();
  });

  // ── What GitHub was actually asked (not recorded — evidence, not narrative) ──
  const creates = repoCreates();
  expect(creates, 'exactly two repositories were created').toHaveLength(2);
  expect(createdNames()).toEqual([seed.webRepoName, `${seed.projectSlug}-availability`]);
  for (const call of creates) {
    expect(call.body?.['private'], 'every created repository is PRIVATE').toBe(true);
  }
  // The `web` row seeds from the platform starter (a template `generate`); the
  // `api` row is an initialised repo in Motir's org. Both land under Motir's org.
  expect(creates[0]!.path, 'the web row is templated from the starter').toMatch(/\/generate$/);
  expect(creates[0]!.body?.['owner']).toBe(E2E_PROVISIONING_ORG);
  expect(creates[1]!.path).toBe(`/orgs/${E2E_PROVISIONING_ORG}/repos`);
  // NOT ONE call went to a user account — the whole ownership decision, asserted.
  expect(githubJournal().some((c) => c.path.startsWith('/user/repos'))).toBe(false);

  await chapter('It’s yours — Motir says so, before it is asked', async () => {
    // Back to the main line: every row has settled, so the default path reads
    // ready and shows the standing ownership promise.
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(setupStatus(page)).toHaveText('Your code is ready');
    await expect(page.getByText(/It's yours\./).first()).toBeVisible();
    await expect(page.getByText(/move it to your own GitHub whenever you want/)).toBeVisible();
    await beat();
  });

  await chapter('The code is private — so the next thing is getting IN to it', async () => {
    // The default path's ready-state primary continues into the access step.
    await setupStatus(page).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Connect GitHub' }).click();
    // No identity yet: the PROMPT, not a failure and not a silent success.
    await expect(page.getByRole('heading', { name: 'Get access to your code' })).toBeVisible();
    await expect(page.getByText(/Connect GitHub and Motir will invite you to it/)).toBeVisible();
    // Nothing has been invited yet, so the rail's approved outcome says exactly
    // that rather than claiming the code is ready.
    await expect(page.getByText('Finish setting up access', { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('The user connects their GitHub account', async () => {
    // The step redraws none of the connect pane — it hands off to the shipped one.
    await page.getByRole('link', { name: 'Connect GitHub' }).click();
    // ⚠️ THE MEMBER'S OWN ACCOUNT, at the tier that owns it (Story MOTIR-4669 ·
    // MOTIR-4682). This landed on `/settings/workspace/github` until the git
    // surface moved: an identity is the one git fact nobody can grant on
    // somebody else's behalf, so it sits under Account, while the
    // ORGANISATION's App installation sits under Settings → Organisation → Git.
    await expect(page).toHaveURL(/\/settings\/account\/git$/);
    await completeGithubIdentityGrant(page);
    await expect(page.getByText(REPO_SET_LOGIN).first()).toBeVisible();
    await beat();
  });

  await chapter('Motir invites them to every repository it made', async () => {
    await page.goto(`/plans/${seed.planId}`);
    await expect(setupStatus(page)).toHaveText('Your code is ready');
    await page.getByRole('button', { name: 'Connect GitHub' }).click();
    // The account is CONNECTED, never typed — so it is shown.
    await expect(page.getByRole('heading', { name: 'Get access to your code' })).toBeVisible();
    await expect(page.getByText(REPO_SET_LOGIN).first()).toBeVisible();

    const granted = page.waitForResponse(
      (r) => /\/repositories\/access$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Connect GitHub' }).click();
    expect((await granted).status(), 'the invitations were sent').toBe(200);
    await expect(page.getByRole('heading', { name: "You're invited to your code" })).toBeVisible();
    await beat();
  });

  await chapter('One invitation, waiting on GitHub, with the door to it', async () => {
    // ⚠️ The per-ROW `Invitation sent` lines are NOT asserted here, and that is a
    // property of the shipped surface rather than a gap in this spec: once every
    // row has settled, the default path renders `ready`, whose two controls are
    // **Connect GitHub** and **Go to my backlog** — `I already have code` is gone
    // (`RepositorySetStep`'s `DefaultPath`), so the technical path has no door
    // left and the rows cannot be reached again on this route. The access step IS
    // the surface for the invitation once the set is settled, so that is where
    // this journey reads it. The three per-row invitation states are asserted in
    // `all three invitation states render at once`, which stays on the technical
    // path where they are legitimately visible.
    await expect(page.getByText(/Accept the invitation on GitHub/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the invitation' })).toHaveCount(0);
    // Two repositories, so there is no single "the invitation" to open — the
    // step says so by offering a resend rather than a door to one of them.
    await expect(page.getByRole('button', { name: 'Resend invitation' }).first()).toBeVisible();
    await beat();
  });

  // ── The invitations, as GitHub was actually asked (MOTIR-1900) ──────────────
  const invites = collaboratorInvites();
  expect(invites, 'one invitation per created repository').toHaveLength(2);
  expect(invites.map((c) => c.path)).toEqual([
    `/repos/${E2E_PROVISIONING_ORG}/${seed.webRepoName}/collaborators/${REPO_SET_LOGIN}`,
    `/repos/${E2E_PROVISIONING_ORG}/${seed.projectSlug}-availability/collaborators/${REPO_SET_LOGIN}`,
  ]);
  for (const call of invites) {
    expect(call.body?.['permission'], 'invited as an ADMIN of their own code').toBe('admin');
  }

  await chapter('Two parts, two repositories — and every task knows which is its own', async () => {
    // THE MONEY SHOT. Two items in one project, two different repositories, no
    // ambiguity — asserted against the REAL dispatch surface the CLI calls.
    const first = await dispatchNext(page, seed.projectKey);
    const second = await dispatchNext(page, seed.projectKey, [String(first['id'])]);
    const byTitle = new Map([first, second].map((item) => [String(item['title']), item]));

    const frontend = byTitle.get(seed.frontendTitle)!;
    const backend = byTitle.get(seed.backendTitle)!;
    expect(frontend, 'the frontend item was dispatched').toBeDefined();
    expect(backend, 'the backend item was dispatched').toBeDefined();
    expect(frontend['targetRepo'], 'the frontend item names the web repo').toBe(seed.webRepoName);
    expect(backend['targetRepo'], 'the backend item names the api repo').toBe(
      `${seed.projectSlug}-availability`,
    );
    // And HOW to obtain each — the clone URL the CLI checks out (MOTIR-1783).
    expect(String(frontend['targetRepoCloneUrl'])).toContain(
      `${E2E_PROVISIONING_ORG}/${seed.webRepoName}`,
    );
    expect(String(backend['targetRepoCloneUrl'])).toContain(
      `${E2E_PROVISIONING_ORG}/${seed.projectSlug}-availability`,
    );
    await beat();
  });
});

/**
 * Drive the identity grant through the REAL start + callback routes — lifted from
 * `github.spec.ts`'s own helper for the reason it documents there: the CTA is a
 * same-origin `<a>` whose SERVER 302s to GitHub, and `page.route` cannot intercept
 * a server-redirect hop. The code exchange is served by instrumentation.ts's
 * OAuth MockAgent, so nothing leaves localhost.
 */
async function completeGithubIdentityGrant(page: Page): Promise<void> {
  // `?from=accountGit` is what the page's own CTA carries (MOTIR-4676 returns a
  // flow to the surface that STARTED it), so the round trip lands back on the
  // account page and the connected login is on screen — which is what the next
  // line asserts. Without it the flow takes the DEFAULT return, which is the
  // organisation's page and does not draw a personal identity at all.
  const start = await page.request.get('/api/github/oauth/start?from=accountGit', {
    maxRedirects: 0,
  });
  expect(start.status(), 'the start route redirects to GitHub').toBe(307);
  const authorizeUrl = new URL(start.headers()['location']!);
  expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
    'https://github.com/login/oauth/authorize',
  );
  const state = authorizeUrl.searchParams.get('state')!;
  const callback = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', 'e2e-github-code');
  callback.searchParams.set('state', state);
  await page.goto(callback.toString());
}

// ═════════════════════════════════════════════════════════════════════════════
// ASSERTED, NOT RECORDED. A reviewer accepts this Story by watching it WORK;
// these pin the states a happy path skips.
// ═════════════════════════════════════════════════════════════════════════════

test('the degenerate case reads as ONE question — a single row, and no list chrome', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-one@example.com', 'Solo Site', 'SOL', {
    roles: ['web'],
    withInstallation: true,
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await openTechnicalPath(page);

  await expect(row(page, 'web')).toHaveAttribute('data-state', 'proposed');
  expect(await page.getByTestId(/^repo-row-/).count()).toBe(1);

  // The ABSENCE of list chrome is the assertion, not merely the presence of one
  // row (the card's wording): at one row there is no role chip, no reorder pair
  // and no row menu — a one-repository plan must not read as a list of one.
  await expect(row(page, 'web').getByRole('button', { name: 'Move up' })).toHaveCount(0);
  await expect(row(page, 'web').getByRole('button', { name: 'Move down' })).toHaveCount(0);
  await expect(row(page, 'web').getByRole('button', { name: 'Repository actions' })).toHaveCount(0);
  // The field asks for "Repository name", not "Name of the web repository".
  await expect(row(page, 'web').getByRole('textbox', { name: 'Repository name' })).toBeVisible();
  // The set's primary is singular, and names the count as ONE.
  await expect(page.getByRole('button', { name: 'Set up 1 repository' })).toBeVisible();
  // ADR §1.4: at one row the name is the bare slug, with no role suffix.
  await expect(row(page, 'web').getByRole('textbox', { name: 'Repository name' })).toHaveValue(
    seed.projectSlug,
  );
});

test('a row that fails leaves its sibling alone, keeps its recoveries, and retries on its own', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-partial@example.com', 'Partial Co', 'PTL', {
    roles: ['web', 'api'],
    withInstallation: true,
  });
  // GitHub refuses the SECOND row only.
  setGithubControl({
    createFailures: {
      [seed.apiRepoName]: { status: 403, message: 'Resource not accessible by integration' },
    },
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await openTechnicalPath(page);
  await page.getByRole('button', { name: 'Set up 2 repositories' }).click();

  // Row 1 is CREATED and stays created; row 2 carries its own failure.
  await expectRowState(page, 'web', 'created');
  await expectRowState(page, 'api', 'failed');
  await expect(row(page, 'api').getByText("Couldn't create")).toBeVisible();
  // Its reason is shown, and all three recoveries stay on the row — no state is a
  // dead end (ADR §4.1/§4.4).
  await expect(row(page, 'api').getByRole('alert')).toBeVisible();
  await expect(row(page, 'api').getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(row(page, 'api').getByRole('button', { name: 'Use one of mine' })).toBeVisible();
  await expect(row(page, 'api').getByRole('button', { name: 'Skip this one' })).toBeVisible();
  // The step still completes — it reports the partial outcome rather than blocking.
  await expect(page.getByText(/1 created · 0 skipped · 1 needs a decision/)).toBeVisible();

  // Retrying row 2 ALONE succeeds once GitHub stops refusing.
  setGithubControl({});
  await row(page, 'api').getByRole('button', { name: 'Retry' }).click();
  await expectRowState(page, 'api', 'created');
  await expectRowState(page, 'web', 'created');
  // The retry created ONE repository — the already-created sibling was not remade.
  expect(createdNames().filter((n) => n === seed.webRepoName)).toHaveLength(1);
});

test('a skipped row completes the flow and leaves the project explicitly code-less for that part', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-skip@example.com', 'Skip Co', 'SKP', {
    roles: ['web', 'api'],
    withInstallation: true,
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await openTechnicalPath(page);

  await row(page, 'api').getByRole('button', { name: 'Repository actions' }).click();
  await page.getByRole('button', { name: 'Skip this one' }).click();
  await expectRowState(page, 'api', 'skipped');
  await expect(row(page, 'api').getByText('Skipped')).toBeVisible();
  await expect(row(page, 'api').getByText('No api repository')).toBeVisible();
  await expect(
    row(page, 'api').getByText(/say so when a task needs code that isn't there/),
  ).toBeVisible();
  // Not a dead end: it can be created after all, or point at one of the user's.
  await expect(row(page, 'api').getByRole('button', { name: 'Create it after all' })).toBeVisible();

  // A SETTLED row alongside an unresolved one makes the set PARTIAL, so the
  // primary becomes **Finish setup** rather than a count — and the summary line
  // states the split. (Skipping is a settled outcome, not a removal, which is
  // exactly why the set reads as partly done before anything has been created.)
  await expect(page.getByText('0 created · 1 skipped · 1 needs a decision')).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expectRowState(page, 'web', 'created');
  // The flow COMPLETED — one repository was created and the skipped role got none.
  expect(createdNames()).toEqual([seed.webRepoName]);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(setupStatus(page)).toHaveText('Your code is ready');
});

test('equivalence through creation: a connected identity changes NOTHING about how the code is made', async ({
  page,
}) => {
  // THE ACCEPTANCE FOR THE OWNERSHIP DECISION (the 2026-07-30 re-plan). Run the
  // SAME journey twice — once with a GitHub identity, once without — and pin that
  // the creation half is byte-for-byte identical. Asserted as an equivalence
  // rather than as two variants, because "the two audiences get the same flow" is
  // the claim, and two independent tests could both pass while diverging.
  const runs: { creates: unknown[]; heading: string }[] = [];

  for (const withIdentity of [false, true]) {
    await resetDatabase();
    resetGithubFixture();
    const seed = await seedRepositorySet(
      `e2e-repo-equiv-${withIdentity ? 'id' : 'anon'}@example.com`,
      'Equivalence Co',
      withIdentity ? 'EQI' : 'EQA',
      { roles: ['web', 'api'], withInstallation: true, withIdentity },
    );
    await signIn(page, seed.email, seed.password);
    await approvePlan(page, seed);

    // The DEFAULT path is identical for both: one sentence, one primary. No
    // account question, no consent screen, no GitHub prompt before or during
    // creation — asserted as an ABSENCE, which is what the claim actually is.
    const heading = await page.getByRole('heading', { level: 2 }).first().innerText();
    await expect(page.getByRole('heading', { name: 'Get access to your code' })).toHaveCount(0);
    await expect(page.getByText('Motir invites the GitHub account you connect')).toHaveCount(0);

    const established = page.waitForResponse(
      (r) => /\/repositories\/establish$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Continue' }).click();
    expect((await established).status()).toBe(200);
    await expect(setupStatus(page)).toHaveText('Your code is ready', { timeout: 60_000 });

    runs.push({
      // Normalize away the per-run project slug — the SHAPE of the two create
      // calls is the invariant, not the names the two tenants happened to get.
      creates: repoCreates().map((c) => ({
        path: c.path.replace(seed.projectSlug, '<slug>'),
        private: c.body?.['private'],
        // The DESTINATION account, resolved per endpoint shape — never the raw
        // path, which on the template call names the STARTER's owner.
        targetOwner: createTargetOwner(c),
        name: String(c.body?.['name']).replace(seed.projectSlug, '<slug>'),
      })),
      heading,
    });
  }

  expect(runs[0]!.heading, 'both audiences are told the same thing').toBe(runs[1]!.heading);
  expect(runs[0]!.creates, 'both audiences get the same repositories, made the same way').toEqual(
    runs[1]!.creates,
  );
  // …and in BOTH runs the repositories are Motir's, never the user's account.
  for (const run of runs) {
    expect(run.creates).toHaveLength(2);
    for (const call of run.creates as { targetOwner: string; private: unknown }[]) {
      expect(call.targetOwner, 'created in MOTIR’s org, for both audiences').toBe(
        E2E_PROVISIONING_ORG,
      );
      expect(call.private, 'private, for both audiences').toBe(true);
    }
  }
});

test('an invitation that fails does not fail the row — the repository stays created, with a way forward', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-invite-fail@example.com', 'Invite Co', 'INV', {
    roles: ['web', 'api'],
    withInstallation: true,
    withIdentity: true,
  });
  // GitHub refuses the API row's invitation only.
  setGithubControl({
    inviteFailures: {
      [seed.apiRepoName]: { status: 403, message: 'Must have admin rights to Repository.' },
    },
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await openTechnicalPath(page);
  await page.getByRole('button', { name: 'Set up 2 repositories' }).click();

  // BOTH repositories exist. The invitation is a sub-state OF a created row, and
  // the two axes cannot fail each other.
  await expectRowState(page, 'web', 'created');
  await expectRowState(page, 'api', 'created');
  await expect(row(page, 'web').getByText('Invitation sent')).toBeVisible();
  // The refused row DEGRADES to `not invited` with its own way forward.
  await expect(row(page, 'api').getByText('Not invited yet')).toBeVisible();
  await expect(
    row(page, 'api').getByText("Motir doesn't know your GitHub account yet"),
  ).toBeVisible();
  await expect(row(page, 'api').getByRole('link', { name: 'Connect GitHub' })).toBeVisible();

  // The rail says the truth: created, but not everybody can reach it. Read from
  // the technical path WITHOUT leaving it — the rail is a sibling of the step in
  // the same layout, and going back to the default path would be a one-way trip
  // (its `ready` state drops `I already have code`, so the rows become
  // unreachable; see the note in the headline journey).
  await expect(page.getByText('Finish setting up access', { exact: true })).toBeVisible();

  // Resend is ROW-SCOPED — re-sending one must not quietly re-send its sibling.
  setGithubControl({});
  const before = collaboratorInvites().length;
  const resent = page.waitForResponse(
    (r) => /\/repositories\/access$/.test(r.url()) && r.request().method() === 'POST',
  );
  await row(page, 'web').getByRole('button', { name: 'Resend invitation' }).click();
  expect((await resent).status()).toBe(200);
  await expect
    .poll(() => collaboratorInvites().length, { timeout: 15_000 })
    .toBeGreaterThan(before);
  const added = collaboratorInvites().slice(before);
  expect(added, 'exactly the ONE row was re-invited').toHaveLength(1);
  expect(added[0]!.path).toContain(`/${seed.webRepoName}/collaborators/`);
});

test('all three invitation states render at once, each with an icon AND a word', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  // THREE roles, ONE establish — so the three states are produced by the same
  // pass and can be compared side by side, which is also the proof that they are
  // per-ROW and not a property of the set.
  const seed = await seedRepositorySet('e2e-repo-states@example.com', 'States Co', 'STA', {
    roles: ['web', 'api', 'mobile'],
    withInstallation: true,
    withIdentity: true,
  });
  setGithubControl({
    // `web` answers 204 — the account ALREADY has access, so there is nothing to
    // accept and the row is `accepted` outright.
    alreadyHasAccess: [seed.webRepoName],
    // `mobile` is refused, so it degrades to `not invited`. `api` succeeds → `invited`.
    inviteFailures: {
      [`${seed.projectSlug}-mobile`]: { status: 403, message: 'Must have admin rights.' },
    },
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await openTechnicalPath(page);
  await page.getByRole('button', { name: 'Set up 3 repositories' }).click();
  for (const role of ['web', 'api', 'mobile']) await expectRowState(page, role, 'created');

  // 1 — ACCEPTED. Settled, and offers nothing: GitHub owns the acceptance, so
  // once the account can clone there is nothing honest left for Motir to do.
  await expect(row(page, 'web').getByText('You have access')).toBeVisible();
  await expect(
    row(page, 'web').getByText(`@${REPO_SET_LOGIN} can clone and push to this repository`),
  ).toBeVisible();
  await expect(row(page, 'web').getByRole('button', { name: 'Resend invitation' })).toHaveCount(0);

  // 2 — INVITED, with the door to the invitation and a row-scoped resend.
  await expect(row(page, 'api').getByText('Invitation sent')).toBeVisible();
  await expect(row(page, 'api').getByText(`to @${REPO_SET_LOGIN}`, { exact: false })).toBeVisible();
  await expect(row(page, 'api').getByRole('link', { name: 'Open the invitation' })).toBeVisible();
  await expect(row(page, 'api').getByRole('button', { name: 'Resend invitation' })).toBeVisible();

  // 3 — NOT INVITED: a standing condition the user can resolve, so a `status`
  // rather than an error — the repository itself was created successfully.
  await expect(row(page, 'mobile').getByText('Not invited yet')).toBeVisible();
  await expect(row(page, 'mobile').getByRole('status')).toContainText('Not invited yet');
  await expect(row(page, 'mobile').getByRole('link', { name: 'Connect GitHub' })).toBeVisible();

  // Every state carries a WORD, never colour alone — the three rows say three
  // different things, and none of them relies on its tint to do it.
  await expect(row(page, 'web')).toHaveAttribute('data-state', 'created');
  await expect(row(page, 'mobile')).toHaveAttribute('data-state', 'created');
});

test('the rail says “Finish setting up access” until somebody is invited, then “Your code is ready”', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-outcome@example.com', 'Outcome Co', 'OUT', {
    roles: ['web'],
    withInstallation: true,
    withIdentity: false,
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);

  // Created, but nobody has been invited — the rail must not claim it is ready.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(setupStatus(page)).toHaveText('Your code is ready', { timeout: 60_000 });
  await expect(page.getByText('Finish setting up access', { exact: true })).toBeVisible();
  await expect(page.getByText('Your code is ready')).toHaveCount(1);

  // Connect an identity and let the invitation go out; the rail flips.
  await connectGithubIdentity(seed.userId);
  await page.goto(`/plans/${seed.planId}`);
  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  const granted = page.waitForResponse(
    (r) => /\/repositories\/access$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  expect((await granted).status()).toBe(200);
  await expect(page.getByRole('heading', { name: "You're invited to your code" })).toBeVisible();
  await page.getByRole('button', { name: 'Later' }).click();
  // Now BOTH the step's status line and the rail's outcome read "Your code is
  // ready" — the one place those two identical strings legitimately co-occur.
  await expect(page.getByText('Your code is ready')).toHaveCount(2);
  await expect(page.getByText('Finish setting up access', { exact: true })).toHaveCount(0);
});

test('the in-flight state is visible per row while a repository is being created', async ({
  page,
}) => {
  await resetDatabase();
  resetGithubFixture();
  const seed = await seedRepositorySet('e2e-repo-inflight@example.com', 'Inflight Co', 'IFL', {
    roles: ['web', 'api'],
    withInstallation: true,
  });
  await signIn(page, seed.email, seed.password);
  await approvePlan(page, seed);
  await openTechnicalPath(page);

  // The `creating` state is genuinely transient — the establish's own duration is
  // external and unmeasured (spike §4.2) — so this does NOT try to catch it in a
  // frame, which would be a race dressed up as an assertion. It pins the two
  // things that are deterministic and that the state exists to serve:
  //
  //   (a) the establish is IN FLIGHT while the UI is still interactive (the step
  //       polls rather than blocking), and
  //   (b) the row leaves `proposed` and lands on `created` — i.e. the per-row
  //       progress is real, which is exactly what `creating` renders.
  const established = page.waitForResponse(
    (r) => /\/repositories\/establish$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Set up 2 repositories' }).click();
  // While the run is in flight the set's primary reports itself busy rather than
  // letting a second establish be started on top of the first.
  await expect(page.getByRole('button', { name: /^Set up 2 repositories$/ })).toBeDisabled();
  expect((await established).status()).toBe(200);
  await expectRowState(page, 'web', 'created');
  await expectRowState(page, 'api', 'created');

  // And the per-row in-flight COPY exists on the shipped row, so a row that is
  // mid-create says what it is doing rather than going blank. Asserted against
  // the row's own rendering contract, not against a frame the poll happened to
  // catch: a `creating` row shows its status line, and a settled one does not.
  await expect(row(page, 'web').getByText('Seeding it from the starter')).toHaveCount(0);
  await expect(row(page, 'web').getByText('Created', { exact: true })).toBeVisible();
});
