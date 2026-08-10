// Acceptance E2E — Story MOTIR-2315: the `/docs` index, the documentation
// area's front door (Subtask MOTIR-2525).
//
// Runs under `playwright.acceptance.config.ts` (video: 'on'), which discovers
// this file by its `acceptance*.spec.ts` name; the bulk shards `testIgnore` the
// same pattern, so it runs ONCE, in the lane that records.
//
// It closes the Story from the seat that matters: someone who has heard of
// Motir, has never used it, and does not yet know whether they want a REST API,
// a command-line tool, an MCP server or a container image. They must be able to
// click **Docs**, land somewhere that tells them which of the four they want,
// go there, change their mind, and come back — without ever typing a URL.
//
// ⚠️ EVERY NAVIGATION IS A CLICK. This spec's whole subject is WHERE THE DOOR
// LEADS, so a `goto('/docs')` would assert that the page exists and skip the
// question. Until this story the door led past this page, at `/docs/api`, and
// a spec that typed the address would have been green throughout.
//
// ── The three failures this catches that no unit test can ──────────────────
//  1. the door still leading to the API reference (the defect itself);
//  2. the page rendering while the REDIRECT still swallows it — `/docs` 308s
//     away, and only a browser following a real click can see that;
//  3. a reader who picks wrong having no way back.
//
// DETERMINISM — no stubs. The surface list renders from the shipped module, and
// the assertions compare against what it DERIVES rather than against routes
// typed into this file, so a fifth surface cannot make this spec silently
// stale. Every wait is on an authoritative signal — a URL or a heading — never
// a timeout.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT, and why ───────────────────
// The rendered COPY of each row. What the four descriptions say is editorial
// and is asserted where it can be read and diffed — `tests/api-docs/`, against
// both catalogs. A browser assertion on marketing prose fails on every reword
// and tells a reviewer nothing about whether the door works, which is what this
// clip is the receipt for.

import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { DOC_SURFACES } from '@/lib/apiDocs/surfaces';
import { DOCS_REDIRECTS } from '../../next.config';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

/** The surface a reader picks FIRST — deliberately not the API reference. */
const FIRST_PICK = DOC_SURFACES.find((surface) => surface.key === 'cli')!;
/** And the one they change their mind to. */
const SECOND_PICK = DOC_SURFACES.find((surface) => surface.key === 'sandbox')!;

test('a stranger clicks Docs, lands on the area rather than the API reference, and chooses the right surface from it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2315');

  // ── 1 — the door ──────────────────────────────────────────────────────────
  await chapter('Click Docs on the public site — and land on the AREA', async () => {
    await page.goto('/explore');
    await expect(page.getByRole('link', { name: 'Motir' }).first()).toBeVisible();
    await beat();

    // THE PUBLIC DOOR. Before this story it led to `/docs/api` — the REST API
    // reference — telling every visitor that the room was the building.
    const docs = page.getByRole('link', { name: 'Docs', exact: true });
    await expect(docs).toBeVisible();
    await docs.click();

    // The area root, not a surface inside it. `waitForURL` on an EXACT match is
    // the assertion: `**/docs/api` would also satisfy a loose glob.
    await page.waitForURL(/\/docs$/);
    await beat();

    // And it renders — which is the half the redirect used to make impossible.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Still signed out. Documentation a reader must sign up to see is not
    // published documentation (ADR Amendment 4 Q4).
    //
    // ⚠️ `exact` is load-bearing, and the reason is a good sign: the CLI row's
    // accessible name is "Motir CLI Install it, sign in, and hand a work item…"
    // — its DESCRIPTION is part of the link's name, which is the property this
    // page is for. A substring match therefore resolves to two links.
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    await beat();
  });

  // ── 2 — choosing, without opening anything ────────────────────────────────
  await chapter('Read four surfaces, each saying what it is and who it is for', async () => {
    // Every surface the product documents is here, each as a real link. Read
    // from the shipped module so a fifth surface cannot leave this spec stale.
    for (const surface of DOC_SURFACES) {
      const row = page.locator(`a[href="${surface.route}"]`);
      await expect(row).toBeVisible();
      // BOTH lines: the name a reader recognises, and the sentence that lets
      // them choose without opening it. A row that is only a label is the list
      // of links this page exists to be better than.
      const text = (await row.innerText()).trim();
      expect(text.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(2);
    }
    await beat();

    // It is the AREA's front door, not the API's: no operation rows anywhere
    // (ADR Amendment 11 Q2 — the operation index renders only under `/docs/api`).
    await expect(page.locator('[data-operation-id]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="catalogue-group-"]')).toHaveCount(0);
    await beat();
  });

  // ── 3 — going somewhere that is not the API ───────────────────────────────
  await chapter('Pick the CLI — a surface the old front door hid', async () => {
    await page.locator(`a[href="${FIRST_PICK.route}"]`).click();
    await page.waitForURL(`**${FIRST_PICK.route}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await beat();

    // Inside a surface the rail appears — the navigation the index does not
    // duplicate (Amendment 19 Q4). This is what makes the index an entrance
    // rather than a hub a reader has to keep coming back to.
    await expect(page.getByRole('navigation', { name: /documentation/i })).toBeVisible();
    await beat();
  });

  // ── 4 — changing their mind ───────────────────────────────────────────────
  await chapter('Change your mind, and cross to a second surface', async () => {
    // The realistic reader does not choose correctly the first time. The rail's
    // first tier lists all four surfaces on every page inside the area, so the
    // way to the next one is one row — no return trip to the index.
    await page
      .getByRole('navigation', { name: /documentation/i })
      .getByRole('link', { name: /agent sandbox/i })
      .click();
    await page.waitForURL(`**${SECOND_PICK.route}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await beat();
  });

  // ── 5 — the other door ────────────────────────────────────────────────────
  await chapter('Reach the same place from the footer', async () => {
    // The footer's product link is the second entrance, and its LABEL moved
    // with its target: a link reading "API docs" that opens the whole area is
    // the same mismatch this story fixes, one layer down.
    await page
      .getByRole('contentinfo')
      .getByRole('link', { name: /documentation/i })
      .click();
    await page.waitForURL(/\/docs$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await beat();
  });

  // ── 6 — the promise to strangers ──────────────────────────────────────────
  await chapter('Every address the area ever served still resolves, in one hop', async () => {
    // Two renames' worth of published addresses. Each must land on a page that
    // RENDERS — not merely answer a 3xx — and it must do it in ONE hop, which
    // is why the map keeps an exact rule ahead of its wildcard.
    for (const source of ['/api-docs', '/api-docs/stability', '/docs/stability']) {
      const response = await page.goto(source);
      expect(response?.status(), `${source} did not resolve`).toBeLessThan(400);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // One hop: the address it landed on is not itself a redirect source.
      const landed = new URL(page.url()).pathname;
      expect(DOCS_REDIRECTS.some((rule) => rule.source === landed)).toBe(false);
      await beat();
    }
  });
});
