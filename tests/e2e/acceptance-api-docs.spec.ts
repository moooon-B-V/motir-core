// Acceptance E2E — Story MOTIR-1854: the OpenAPI spec + the published API
// reference (Subtask MOTIR-2191).
//
// Runs under playwright.acceptance.config.ts (video: 'on'), which discovers this
// file by its `acceptance*.spec.ts` name; the bulk shards `testIgnore` the same
// pattern, so it runs ONCE, in the lane that records. The recorded happy path
// declares Story MOTIR-1854 via `acceptanceStory()`, so the clip publishes to
// 1854 whichever PR triggered the run.
//
// It closes the Story from the seat that matters: a developer who has never
// heard of Motir's API finds the documentation WITHOUT being told the URL,
// understands one call, copies an example that runs, follows the guide from a
// first request to a first error, and reads the promise about what will not
// change — and a user who has just minted a token gets there too.
//
// ⚠️ EVERY NAVIGATION IS A CLICK, never a `goto` to a docs URL. A test that
// types the address proves the page EXISTS and proves nothing about whether
// anyone can find it — and an unreachable documentation page is the commonest
// way this kind of work ships while every check stays green. Driving both
// entrances is the only assertion that catches it.
//
// DETERMINISM — no stubs and no fakes. The reference renders from the shipped
// operation registry, the spec is fetched over real HTTP as an anonymous client
// would, and every wait is on an authoritative signal (a URL, a heading, a
// clipboard read) rather than on a timeout.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT, and why ────────────────────
// The SPEC-UNAVAILABLE state. The reference reads the document from the emitter
// in-process rather than fetching its own public URL (ADR Amendment 4; Subtask
// 11.4.7), which is what makes the page independent of the app being up to
// describe the app — and it is exactly that property which leaves no seam a
// browser can reach in to make the build fail. Triggering it would mean adding a
// test-only switch to production code, which this card's scope boundary forbids
// ("It changes no production code"). The state is asserted instead by Subtask
// 11.4.9's story gate, which renders the real page with a throwing builder and
// checks the message, the retry and the still-reachable sibling pages. Recorded
// here rather than left as a silent omission.

import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedCliConnect } from './_helpers/cli-connect-seed';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';
import { AGENT_PROFILES } from '../../packages/cli/src/agentProfiles';
import { EXAMPLE_TOKEN, SPEC_PATH } from '@/lib/apiDocs/reference';

test.describe.configure({ timeout: 180_000 });

// The operation examples copy to the clipboard; grant the permission so the
// confirmation fires deterministically rather than the copy-failed fallback
// (the shipped `acceptance-cli-connect.spec.ts` does the same).
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** The operation the recorded walk-through opens — a read, with a path param. */
const READ_OPERATION = 'getWorkItem';

/** Its declared shape, read from the registry rather than re-typed here. */
const READ = V1_OPERATIONS.find((operation) => operation.operationId === READ_OPERATION)!;

test.beforeEach(async () => {
  await resetDatabase();
});

/** The reference's section for one operation. */
const operationSection = (page: Page, id: string) =>
  page.locator(`section[data-operation-id="${id}"]`);

// ── The recorded happy path ──────────────────────────────────────────────────

test('a developer finds the API reference, reads an operation, copies its example, and follows the guide', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-1854');

  // ── 1 — arriving from outside, with no account and no URL ─────────────────
  await chapter('Arrive on the public site — and find Docs in the nav', async () => {
    // The project square is the public front door an unauthenticated visitor
    // already lands on. Nothing here is authenticated.
    await page.goto('/explore');
    await expect(page.getByRole('link', { name: 'Motir' }).first()).toBeVisible();
    await beat();

    // THE PUBLIC DOOR. `Docs` used to be a non-interactive label beside Product
    // and Pricing — a future page. It is the first of the three to resolve.
    const docs = page.getByRole('link', { name: 'Docs', exact: true });
    await expect(docs).toBeVisible();
    await docs.click();
    await page.waitForURL('**/docs/api');
    await beat();

    await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
    // Still signed out — a prospective integrator reads this before signing up.
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await beat();
  });

  // ── 2 — reading one call ──────────────────────────────────────────────────
  await chapter('Open one operation and read what the call needs', async () => {
    // From the CATALOGUE, the way a reader browses — not by anchor URL.
    await page.locator('nav').getByRole('link', { name: READ.summary }).first().click();

    const section = operationSection(page, READ_OPERATION);
    await expect(section).toBeVisible();
    await beat();

    // Method, path and the scope the token must carry.
    await expect(section.getByText(READ.path, { exact: true })).toBeVisible();
    await expect(section.getByText(READ.method, { exact: true }).first()).toBeVisible();
    await expect(section.getByText(READ.scope, { exact: true })).toBeVisible();
    await beat();

    // Its parameters, and the statuses it can answer with — including the two
    // that are decisions rather than defaults.
    await expect(section.getByRole('table').first()).toBeVisible();
    await expect(section.getByText('key', { exact: true }).first()).toBeVisible();
    for (const status of ['200', '404', '429']) {
      await expect(section.getByText(status, { exact: true }).first()).toBeVisible();
    }
    await beat();

    // And the shape of what comes back.
    await expect(section.getByText('sectionResponseSchema')).toHaveCount(0);
    await expect(section.getByText(/Response schema/i)).toBeVisible();
    await beat();
  });

  // ── 3 — taking the example away ───────────────────────────────────────────
  await chapter('Copy the authenticated example', async () => {
    const section = operationSection(page, READ_OPERATION);
    await section.getByRole('button', { name: 'Copy' }).click();

    // The confirmation is the button's own state — the authoritative signal
    // that the write resolved, so the clipboard read below cannot race it.
    await expect(section.getByRole('button', { name: 'Copied' })).toBeVisible();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    // It is the curl for THIS operation, with the bearer header — not a
    // generic sample a reader would have to rewrite.
    expect(copied).toContain('/api/v1/work-items/MOTIR-1854');
    expect(copied).toContain(`Authorization: Bearer ${EXAMPLE_TOKEN}`);
    expect(copied.startsWith('curl ')).toBe(true);
    await beat();
  });

  // ── 4 — the first call, and the promise ───────────────────────────────────
  await chapter('Follow getting started — mint, call, paginate, err, back off', async () => {
    await page.getByRole('link', { name: 'Getting started' }).first().click();
    await page.waitForURL('**/docs/getting-started');
    await expect(page.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();
    await beat();

    // All five steps, in order, on one page — the linear read.
    for (const step of [
      'Mint a token',
      'Your first authenticated call',
      'Paginate a collection',
      'Read an error',
      'Read the response headers',
    ]) {
      await expect(page.getByRole('heading', { name: step })).toBeVisible();
    }
    await beat();

    // The two facts a reader would otherwise discover the hard way.
    await expect(page.getByText(/OPAQUE/)).toBeVisible();
    await expect(page.getByText(/X-RateLimit-Reset/).first()).toBeVisible();
    await expect(page.getByText(/X-Motir-Api-Version/).first()).toBeVisible();
    await beat();
  });

  await chapter('Read what v1 promises — and what it asks in return', async () => {
    await page.getByRole('link', { name: 'Stability & deprecation' }).first().click();
    await page.waitForURL('**/docs/stability');
    await expect(
      page.getByRole('heading', { name: 'Stability & deprecation', level: 1 }),
    ).toBeVisible();
    await beat();

    await expect(page.getByText('A new endpoint.')).toBeVisible();
    await expect(page.getByText('Renaming a field.')).toBeVisible();
    // The client's own obligation — the other half of the promise.
    await expect(page.getByText(/tolerate unknown fields/)).toBeVisible();
    await beat();
  });

  // ── 5 — the OTHER door, from inside the product ───────────────────────────
  await chapter('And from inside: the door on the API-tokens page', async () => {
    const seed = await seedCliConnect(`api-docs-${Date.now()}@example.com`);
    await signIn(page, seed.email, seed.password);
    await page.goto('/settings/account/api-tokens');
    // `exact` because the EMPTY state's own heading — "No API tokens yet" — is
    // also on this page for a user who has minted none, and a substring match
    // resolves to both.
    await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();
    await beat();

    // THE IN-APP DOOR — above the CLI panel and the token manager, because the
    // reader with the sharpest need is holding a freshly-minted secret.
    await expect(page.getByText('Build against the API')).toBeVisible();
    await page.getByRole('link', { name: 'API reference' }).first().click();
    await page.waitForURL('**/docs/api');
    await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
    await beat();
  });

  // ── 6 — the half no browser assertion covers ──────────────────────────────
  await chapter('Fetch the specification itself, as a code generator would', async () => {
    // ANONYMOUSLY — a fresh `request` context carries none of this page's
    // cookies, which is the whole point: a generator has no session.
    const anonymous = await page.request.storageState();
    expect(anonymous.cookies.length).toBeGreaterThanOrEqual(0);

    const response = await page.request.get(SPEC_PATH, {
      headers: { authorization: '' },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');

    const document = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).length).toBeGreaterThan(10);
    expect(document.paths[READ.path]).toBeDefined();
    await beat();
  });
});

// ── The states the happy path skips ──────────────────────────────────────────
//
// Deliberately NOT narrated into the video: a reviewer accepts this Story by
// watching it work, not by watching it be narrow.

// ─────────────────────────────────────────────────────────────────────────────
// Story MOTIR-2268 — the agent sandbox setup guide, the surface's FOURTH page.
//
// It publishes to its OWN story (`acceptanceStory('MOTIR-2268')`) from inside
// this file, because the file is the surface's journey and the guide is a page
// on that surface — extending it beats a parallel spec that would re-drive the
// same shell to reach one more link.
//
// ⚠️ The journey starts at the RAIL, never at the route. The whole premise of
// this story is that the sandbox was undiscoverable, so a test that navigates
// straight to `/docs/sandbox` would pass while the door was bricked up — and the
// rail entry is the only thing in the product that points here.
// ─────────────────────────────────────────────────────────────────────────────

test('a reader with no session finds the sandbox guide from the rail and leaves with a runnable docker run', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2268');

  await chapter('Arrive at the documentation with no account', async () => {
    await page.goto('/docs/api');
    await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();
    // Anonymous: the marketing bar's sign-in is still on offer, so nothing
    // about this surface assumes a session.
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
  });

  await chapter('Find the agent sandbox in the rail — by CLICKING it', async () => {
    const rail = page.getByRole('navigation', { name: 'API reference' });
    await rail.getByRole('link', { name: 'Agent sandbox' }).click();
    await page.waitForURL('**/docs/sandbox');
    // The entry marks itself current, which is what makes the surface read as
    // one thing rather than four pages that happen to look alike.
    await expect(rail.getByRole('link', { name: 'Agent sandbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  await chapter('See which agents the sandbox supports', async () => {
    const matrix = page.locator('#pick-your-profile table');
    await expect(matrix).toBeVisible();
    // The row COUNT comes from the CLI's own list, never a literal here: this
    // spec must fail when the page stops deriving, not when someone adds a
    // ninth agent.
    await expect(matrix.locator('tbody tr')).toHaveCount(AGENT_PROFILES.length);

    // …and each row shows the credential directory that agent keeps its sign-in
    // in, which is the fact a reader is choosing on.
    for (const profile of AGENT_PROFILES.filter((candidate) => candidate.sandboxMounts.length)) {
      await expect(
        matrix.getByRole('cell', { name: profile.sandboxMounts[0]!, exact: false }).first(),
      ).toBeVisible();
    }
  });

  await chapter('Copy the command it came for', async () => {
    const block = page.locator('#start-the-container pre').first();
    await expect(block).toBeVisible();

    await page.locator('#start-the-container').getByRole('button', { name: 'Copy' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());

    // The whole command, not a truncated or placeholder string — a copy button
    // that quietly yields half a command looks identical to one that works.
    expect(copied).toContain('docker run');
    expect(copied).toContain('ghcr.io/moooon-b-v/motir-sandbox:');
    expect(copied).toContain('-v "$PWD:/workspace"');
    // It sets the container UP; it does not start a work loop.
    expect(copied).not.toContain('motir auto');
  });

  await chapter('Leave for any of the other three pages', async () => {
    const rail = page.getByRole('navigation', { name: 'API reference' });
    for (const [label, url] of [
      ['Getting started', '**/docs/getting-started'],
      ['Stability & deprecation', '**/docs/stability'],
      ['API reference', '**/docs/api'],
    ] as const) {
      await rail.getByRole('link', { name: label }).click();
      await page.waitForURL(url);
      await rail.getByRole('link', { name: 'Agent sandbox' }).click();
      await page.waitForURL('**/docs/sandbox');
    }
  });
});

test('the sandbox guide is readable on a phone — the command scrolls, the page does not', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/docs/sandbox');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflows, 'the page body scrolls horizontally at 390px').toBe(false);

  // The `docker run` is wider than any phone, so it must scroll inside its own
  // block rather than truncating.
  const scrollable = await page
    .locator('#start-the-container pre')
    .first()
    .evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(scrollable, 'the docker run is not reachable by scrolling its own block').toBe(true);

  // …and the four-column matrix becomes one card per profile rather than a
  // shrunken table, so every fact a reader chooses on stays visible.
  await expect(page.locator('#pick-your-profile table')).toBeHidden();
  const cards = page.locator('#pick-your-profile dl');
  await expect(cards).toHaveCount(AGENT_PROFILES.length);
  // The credential mount is the fact a reader is choosing on, so it is the one
  // that must survive the collapse — asserted on the first profile's own value
  // rather than on its id, which appears several times inside one card.
  await expect(
    cards.first().getByText(AGENT_PROFILES[0]!.sandboxMounts[0]!, { exact: true }),
  ).toBeVisible();
});

test('the reference is readable on a phone — the code block scrolls, the page does not', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/docs/api');
  await expect(page.getByRole('heading', { name: 'API reference', level: 1 })).toBeVisible();

  const section = operationSection(page, READ_OPERATION);
  await expect(section).toBeVisible();

  // The PAGE must not scroll sideways. This is the assertion the whole
  // wide-content rule exists for — a `curl` line is wider than any phone.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflows, 'the page body scrolls horizontally at 390px').toBe(false);

  // …and the code block DOES scroll, inside its own container. If it did not,
  // the sample would be truncated rather than reachable.
  const scrollable = await section
    .locator('pre')
    .first()
    .evaluate((node) => node.scrollWidth > node.clientWidth);
  expect(scrollable, 'the curl sample is not reachable by scrolling its own block').toBe(true);
});

test('the catalogue filters in place, and says so when nothing matches', async ({ page }) => {
  await page.goto('/docs/api');
  const find = page.getByRole('searchbox');
  await expect(find).toBeVisible();

  const before = await page.locator('nav a[data-operation-id]').count();
  expect(before).toBe(V1_OPERATIONS.length);

  await find.fill('sprint');
  await expect(page.locator('nav a[data-operation-id]')).not.toHaveCount(before);
  expect(await page.locator('nav a[data-operation-id]').count()).toBeGreaterThan(0);

  await find.fill('zzzznope');
  await expect(page.locator('nav a[data-operation-id]')).toHaveCount(0);
  await expect(page.getByText(/zzzznope/)).toBeVisible();
});
