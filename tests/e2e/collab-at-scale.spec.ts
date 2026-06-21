// E2E: the collaboration-LOADED issue AT SCALE (Story 5.6, Subtask 5.6.3) —
// the finding-#57 sentinel for Epic 5. Selected by the `collab-at-scale` grep
// (the verification recipe runs `pnpm test:e2e --grep collab-at-scale`); it is
// EXCLUDED from the default `pnpm test:e2e` run (the heavy 5.6.1 seed is slow)
// and gets its own reduced-cap CI step, exactly like board-at-scale.
//
// ── What ONLY this spec proves (vs. the per-story closers) ────────────────────
// Each Epic-5 story already proved ITS OWN collection stays cursor-paged on a
// single-collection fixture: comments (5.1.7, 105 rows), attachments (5.2.8,
// 120 rows), the History/All feeds (5.5.5, 220 changes + 50 comments). THIS
// spec is the only one that opens the 5.6.1 LOADED issue — every collection
// heavy AT ONCE (hundreds of comments, dozens of attachments, a full rail,
// 15+ watchers, 400+ revisions) — and asserts the seams hold TOGETHER:
//
//   1. Bounded reads (finding #57): opening the loaded issue first-paints ONE
//      page of every collection (server-rendered) behind a "Show more" edge,
//      and every network read the page issues — extending each collection, the
//      activity tabs, the watchers popover — carries at most one page. No
//      response ever returns the full collection (the load-all the rule
//      forbids). This file is the regression net future Epic-5-touching PRs
//      inherit (the spec header documents it as the Epic-5 sentinel).
//   2. Bounded DOM: first paint mounts at most one page per collection, and
//      extending one page appends exactly one more page's worth — never the
//      whole set.
//   3. Interaction at load: Show-more on each collection, the activity tab
//      switches, the watchers popover, and one comment post on the loaded issue
//      all complete without timeout at the CI cap (the smoke that catches an
//      accidental load-all-then-filter regression).
//   4. The full-page strict a11y sweep: the loaded detail page with EVERY
//      Epic-5 surface populated simultaneously — comments thread + attachments
//      panel + full rail (custom fields, labels, components) + watch control +
//      activity — passes the strict WCAG sweep in light AND dark. No per-story
//      sweep renders this combined state; landmark/heading uniqueness and focus
//      order across the stacked sections are exactly the class of bug only the
//      combined page shows.
//
// Out of scope (an owning story already covers it on its single-collection
// fixture): the per-collection sort/view toggles' no-refetch property, the
// exact page-edge counts, the role/permission grammar. This spec asserts the
// COMBINED page, not any one surface in isolation.
//
// ── How it reaches scale cheaply ─────────────────────────────────────────────
// `runCollabSeed()` (the 5.6.1 child-process seed) builds the loaded issue
// through the shipped services. The seed is cap-parameterised by the SEED_COLLAB_*
// envs (the board-at-scale precedent): the CI lane lowers them so the run stays
// fast while every collection still EXCEEDS its page size (so paging actually
// engages); locally, unset envs seed full size. The beforeAll guard fails loud
// if a lane lowers a cap so far that a collection no longer exceeds its page
// size (the inverse of board-at-scale's "cap too high" guard) — otherwise
// "paged" and "load-all" would look identical and the census would be vacuous.

import os from 'node:os';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  collabSeedSizes,
  getCollabFixture,
  runCollabSeed,
  SEED_COLLAB_LOADED_TITLE,
  SEED_COLLAB_OWNER_EMAIL,
  SEED_COLLAB_PASSWORD,
  type CollabFixture,
} from './_helpers/collab';
import { COMMENT_PAGE_SIZE } from '@/lib/services/commentsService';
import { ATTACHMENT_PAGE_SIZE } from '@/lib/services/attachmentsService';
import { ACTIVITY_PAGE_SIZE } from '@/lib/services/activityService';
import { WATCHER_PAGE_SIZE } from '@/lib/services/watchersService';

// The 5.6.1 seed (hundreds of comments + 400+ revisions through the real
// services) plus many per-collection loads: well beyond the 30s default, even
// at the reduced CI cap.
test.describe.configure({ timeout: 180_000 });

// Sign in ONCE (in the beforeAll warm-up) and reuse that session across all
// tests via storageState — the seed user's sign-in is the heaviest, flakiest
// step (the email→password handoff can stall on a busy dev server), so doing it
// per-test is both slow and a flake source. The warm-up writes this file; every
// test's context loads it, so no test signs in.
const STORAGE_STATE = path.join(os.tmpdir(), 'collab-at-scale-auth.json');
test.use({ storageState: STORAGE_STATE });

// ── The bounded-read census ──────────────────────────────────────────────────
// Every collection endpoint the loaded detail page reads, keyed to the response
// field that carries its rows and the page size that bounds it. A census records
// the length of each captured array; the contract is that NONE exceeds its page
// size — the load-all finding #57 forbids never fired.
const COLLECTIONS = {
  comments: {
    re: /\/api\/work-items\/[^/]+\/comments(\?|$)/,
    field: 'threads',
    pageSize: COMMENT_PAGE_SIZE,
  },
  attachments: {
    re: /\/api\/work-items\/[^/]+\/attachments(\?|$)/,
    field: 'attachments',
    pageSize: ATTACHMENT_PAGE_SIZE,
  },
  history: {
    re: /\/api\/work-items\/[^/]+\/activity\/history(\?|$)/,
    field: 'entries',
    pageSize: ACTIVITY_PAGE_SIZE,
  },
  all: {
    re: /\/api\/work-items\/[^/]+\/activity\/all(\?|$)/,
    field: 'entries',
    pageSize: ACTIVITY_PAGE_SIZE,
  },
  watchers: {
    re: /\/api\/work-items\/[^/]+\/watchers(\?|$)/,
    field: 'watchers',
    pageSize: WATCHER_PAGE_SIZE,
  },
} as const;

type CollectionKey = keyof typeof COLLECTIONS;
type Census = Record<CollectionKey, number[]>;

/**
 * Attach a response listener that records, per collection, the length of the
 * rows array each GET returns. Returns the census object the test asserts
 * against after exercising the page.
 */
function installCensus(page: Page): Census {
  const census: Census = { comments: [], attachments: [], history: [], all: [], watchers: [] };
  page.on('response', (res) => {
    if (res.request().method() !== 'GET') return;
    const url = res.url();
    for (const [key, spec] of Object.entries(COLLECTIONS) as [
      CollectionKey,
      (typeof COLLECTIONS)[CollectionKey],
    ][]) {
      if (!spec.re.test(url)) continue;
      void res
        .json()
        .then((body: Record<string, unknown>) => {
          const rows = body[spec.field];
          if (Array.isArray(rows)) census[key].push(rows.length);
        })
        .catch(() => {
          // Non-JSON / aborted response — not a page read; ignore.
        });
      return;
    }
  });
  return census;
}

/** Assert every captured read on `key` stayed within (≤) its page size. */
function expectBounded(census: Census, key: CollectionKey): void {
  const reads = census[key];
  const { pageSize } = COLLECTIONS[key];
  const max = reads.length ? Math.max(...reads) : 0;
  expect(
    max,
    `${key} reads ${JSON.stringify(reads)} must each be ≤ the ${pageSize} page size`,
  ).toBeLessThanOrEqual(pageSize);
}

// ── Stable section hooks (the 5.1.5 / 5.2.x / 5.5.x components expose these) ──
const threadList = (page: Page): Locator => page.getByRole('list', { name: 'Comments' });
const fileList = (page: Page): Locator => page.getByRole('list', { name: 'Attachments' });
const historyFeed = (page: Page): Locator => page.getByRole('list', { name: 'History' });
const allFeed = (page: Page): Locator => page.getByRole('list', { name: 'All activity' });
const watchButton = (page: Page): Locator =>
  page.getByRole('button', { name: /(Watch|Stop watching) — \d+ watching/ });
const watchersPopover = (page: Page): Locator => page.getByRole('dialog', { name: 'Watchers' });
const showMoreComments = (page: Page): Locator =>
  page.getByRole('button', { name: /^Show more comments \(\d+ older\)$/ });
const showMoreAttachments = (page: Page): Locator =>
  page.getByRole('button', { name: /^Show more \(\d+\)$/ });

async function switchActivityTab(page: Page, tab: 'All' | 'Comments' | 'History'): Promise<void> {
  await page
    .getByRole('group', { name: 'Activity filter' })
    .getByRole('button', { name: tab, exact: true })
    .click();
}

/**
 * Extend an activity feed one cursor page — the client read the census bounds.
 * The feed's first page is SERVER-prefetched (a tab switch alone fires no
 * request), so the "Show more" edge is what issues the bounded GET. The click
 * is retried until the census records the read: the detail page's relative-time
 * stamps can mismatch SSR↔client and hydration-fail the page, silently dropping
 * a click into the pre-regeneration DOM (the finding-#89 hazard the activity
 * spec also guards). Looping only while the read hasn't landed never doubles a
 * click that DID fire.
 */
async function extendActivityFeed(
  page: Page,
  key: 'history' | 'all',
  census: Census,
): Promise<void> {
  const edge =
    key === 'history' ? /^Show more changes \(\d+ older\)$/ : /^Show more activity \(\d+ older\)$/;
  await expect(async () => {
    const button = page.getByRole('button', { name: edge }).first();
    if (await button.isVisible()) await button.click();
    expect(census[key].length, `the ${key} feed issued a bounded read`).toBeGreaterThan(0);
  }).toPass({ timeout: 20_000 });
}

/** Open the loaded issue's detail page and wait for its title heading. */
async function gotoLoadedIssue(page: Page): Promise<void> {
  await page.goto(`/items/${fixture.loadedIssue.identifier}`);
  await expect(
    page.getByRole('heading', { name: SEED_COLLAB_LOADED_TITLE, level: 1 }),
  ).toBeVisible();
}

/**
 * Click a "Show more" edge until the collection's mounted count grows. The
 * click is RETRIED because the loaded detail page renders hundreds of
 * relative-time stamps that mismatch SSR↔client, hydration-fail the page (the
 * `ENVIRONMENT_FALLBACK` flood — finding #89), and React regenerates the client
 * tree — silently dropping a click dispatched into the pre-regeneration DOM (the
 * same hazard the activity spec's `extendFeed` guards). Re-clicking only while
 * the count has NOT grown never doubles a click that did land (a landed click
 * grew the count → the loop exits).
 */
async function clickShowMoreUntilGrown(
  page: Page,
  edge: Locator,
  count: () => Promise<number>,
  before: number,
): Promise<void> {
  await expect(async () => {
    if (await edge.isVisible()) await edge.click();
    expect(await count(), 'the collection appended a bounded page').toBeGreaterThan(before);
  }).toPass({ timeout: 30_000 });
}

/**
 * Run a click-style action until a follow-up expectation holds — the finding-#89
 * retry for an IDEMPOTENT interaction (opening a tab, opening the composer):
 * re-running the action is a no-op once it has landed, so the retry is safe.
 */
async function actUntil(action: () => Promise<void>, confirm: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await action();
    await confirm();
  }).toPass({ timeout: 30_000 });
}

/**
 * Compile + warm every route the loaded-issue tests touch, in a throwaway
 * context, so the real tests never hit a COLD route. This spec runs in its own
 * dedicated CI step (a fresh `pnpm dev`), so it is the FIRST and ONLY caller of
 * the issue page's `?activity=` variants and the collection API routes in that
 * server — and Next.js dev compiles routes on first hit. A cold first hit is
 * erratic (the `?activity=history` page render transiently redirects to
 * /sign-in; a cold API route 404s) until the route is compiled. The default
 * `pnpm test:e2e` lane's activity.spec.ts warms these, but it runs against a
 * DIFFERENT server. So we warm them here, retrying each until it settles, which
 * also primes the sign-in route for the per-test sign-ins. (A no-op against an
 * already-warm server — production builds never hit this.)
 */
async function warmIssueRoutes(browser: Browser): Promise<void> {
  // Start UNAUTHENTICATED (override the file-level `test.use({ storageState })`,
  // which would otherwise make newContext try to read the not-yet-written file):
  // this context signs in fresh and PRODUCES that state file.
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  try {
    await signIn(page, SEED_COLLAB_OWNER_EMAIL, SEED_COLLAB_PASSWORD);
    // Page routes: the base view + each activity tab variant. Retry the whole
    // navigation until the title heading renders (a cold redirect to /sign-in
    // leaves it absent).
    for (const suffix of ['', '?activity=history', '?activity=all']) {
      await expect(async () => {
        await page.goto(`/items/${fixture.loadedIssue.identifier}${suffix}`);
        await expect(
          page.getByRole('heading', { name: SEED_COLLAB_LOADED_TITLE, level: 1 }),
        ).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 90_000 });
    }
    // API routes: hit each collection endpoint until it answers 200 (a cold
    // route 404s on first compile).
    const base = `/api/work-items/${fixture.loadedIssue.id}`;
    const endpoints = [
      `${base}/comments`,
      `${base}/attachments`,
      `${base}/activity/history`,
      `${base}/activity/all`,
      `${base}/watchers`,
    ];
    for (const endpoint of endpoints) {
      await expect(async () => {
        const res = await page.request.get(endpoint);
        expect(res.status(), `warming ${endpoint}`).toBe(200);
      }).toPass({ timeout: 30_000 });
    }
    // Persist this signed-in session for every test to reuse (the one sign-in).
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await context.close();
  }
}

let fixture: CollabFixture;

test.beforeAll(async ({ browser }) => {
  // The seed (40+ comments + 60+ edits through the real services, each firing a
  // stubbed Inngest event) plus the route warm-up runs well past Playwright's
  // default 30s HOOK timeout (the describe-level test timeout does not cover
  // hooks), so set this hook's own budget generously.
  test.setTimeout(300_000);

  // Seed the 5.6.1 loaded issue through the shipped services (the child process
  // inherits whatever SEED_COLLAB_* the lane set — full size locally, reduced in
  // CI). Idempotent: it clears and reseeds its own workspace only.
  await runCollabSeed();
  fixture = await getCollabFixture();

  // The census is only meaningful when each large collection EXCEEDS its page
  // size — otherwise a single bounded read returns the whole set and "paged"
  // vs. "load-all" are indistinguishable. Fail loud (the inverse of
  // board-at-scale's cap guard) when a lane lowered a knob too far. Watchers are
  // intentionally excluded: the seed team is ~17 (< the 20 page size), so the
  // watcher roster is a single bounded page by design — its census asserts the
  // read is bounded, not that it pages.
  const { counts } = fixture;
  const attachments = counts.panelAttachments + counts.editorAttachments;
  const tooSmall: string[] = [];
  if (counts.comments <= COMMENT_PAGE_SIZE)
    tooSmall.push(`comments ${counts.comments} ≤ ${COMMENT_PAGE_SIZE}`);
  if (attachments <= ATTACHMENT_PAGE_SIZE)
    tooSmall.push(`attachments ${attachments} ≤ ${ATTACHMENT_PAGE_SIZE}`);
  if (counts.revisions <= ACTIVITY_PAGE_SIZE)
    tooSmall.push(`revisions ${counts.revisions} ≤ ${ACTIVITY_PAGE_SIZE}`);
  if (tooSmall.length > 0) {
    throw new Error(
      `collab-at-scale: each large collection must EXCEED its page size so paging engages, but ` +
        `${tooSmall.join(', ')}. Raise the SEED_COLLAB_* env for this lane (the configured sizes are ` +
        `${JSON.stringify(collabSeedSizes())}).`,
    );
  }

  // Compile the issue's page + API routes so the tests below run warm (this
  // step's dev server is fresh; cold first hits are erratic — see the helper).
  await warmIssueRoutes(browser);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test.describe('collab-at-scale — bounded load (5.6.3)', () => {
  test('first paint mounts ONE page of every collection behind a "Show more" edge — bounded DOM, never load-all', async ({
    page,
  }) => {
    const census = installCensus(page);
    await gotoLoadedIssue(page);

    // ── Comments: the newest page of ROOTS is server-rendered behind the edge.
    // Roots are the Comments list's DIRECT children (replies nest inside each
    // root's own sublist); the "Show more comments (N older)" edge is ITSELF the
    // list's leading `<li>`, so one page of roots is COMMENT_PAGE_SIZE + 1 direct
    // children. A bounded count proves the first page didn't dump the whole
    // thread (the full set would be every root, far past one page).
    await expect(showMoreComments(page)).toBeVisible();
    const rootCount = await threadList(page).locator('> li').count();
    expect(
      rootCount,
      'first paint mounts ≤ one page of comment roots (+ the edge li)',
    ).toBeLessThanOrEqual(COMMENT_PAGE_SIZE + 1);

    // ── Attachments: exactly the newest page (the total exceeds it — guarded in
    // beforeAll), the rest behind "Show more (N)".
    await expect(fileList(page).getByRole('listitem')).toHaveCount(ATTACHMENT_PAGE_SIZE);
    await expect(showMoreAttachments(page)).toBeVisible();

    // ── The full rail is populated simultaneously: custom fields (all five
    // types — one of the seeded labels proves the section rendered), and the
    // watch control with its live count.
    await expect(page.getByText('Gateway reference')).toBeVisible();
    await expect(watchButton(page)).toBeVisible();

    // ── Census: nothing read on first paint exceeded a page size. (The first
    // pages are server-rendered, so this may capture zero client reads — the
    // bounded DOM above is the first-paint proof; the network bound is asserted
    // hard once the page extends, below.)
    for (const key of Object.keys(COLLECTIONS) as CollectionKey[]) expectBounded(census, key);
  });

  test('extending each collection appends exactly one page; tabs, watchers, and a comment post all stay bounded (finding #57)', async ({
    page,
  }) => {
    const census = installCensus(page);
    await gotoLoadedIssue(page);

    // ── Comments: extend one cursor page; the mounted roots grow by at most one
    // page (never the whole backlog). The "Show more" edge may vanish if this
    // page exhausts the backlog (at the reduced cap there are ~2 pages), so we
    // assert the bounded GROWTH, not a lingering edge.
    const rootsBefore = await threadList(page).locator('> li').count();
    await clickShowMoreUntilGrown(
      page,
      showMoreComments(page),
      () => threadList(page).locator('> li').count(),
      rootsBefore,
    );
    const rootsAfter = await threadList(page).locator('> li').count();
    // One page is COMMENT_PAGE_SIZE roots; the leading edge `<li>` may toggle, so
    // allow ±1 around the page size.
    expect(
      rootsAfter - rootsBefore,
      'comments append at most one page of roots',
    ).toBeLessThanOrEqual(COMMENT_PAGE_SIZE + 1);

    // ── Attachments: extend exactly one page (50 → 100 when ≥ 100 remain, else
    // the remainder) — bounded append, not load-all.
    const filesBefore = await fileList(page).getByRole('listitem').count();
    await clickShowMoreUntilGrown(
      page,
      showMoreAttachments(page),
      () => fileList(page).getByRole('listitem').count(),
      filesBefore,
    );
    const filesAfter = await fileList(page).getByRole('listitem').count();
    expect(filesAfter - filesBefore, 'attachments append at most one page').toBeLessThanOrEqual(
      ATTACHMENT_PAGE_SIZE,
    );

    // ── Activity History: switch to the tab (its first page is SSR-prefetched
    // behind the edge), then extend one page — the bounded client read. The tab
    // switch is retried (finding #89) until its feed mounts.
    await actUntil(
      () => switchActivityTab(page, 'History'),
      () => expect(historyFeed(page)).toBeVisible({ timeout: 3_000 }),
    );
    await extendActivityFeed(page, 'history', census);

    // ── Activity All: the merged stream; extend the composite cursor one page.
    await actUntil(
      () => switchActivityTab(page, 'All'),
      () => expect(allFeed(page)).toBeVisible({ timeout: 3_000 }),
    );
    await extendActivityFeed(page, 'all', census);
    // Back to the comment composer's tab for the post below.
    await actUntil(
      () => switchActivityTab(page, 'Comments'),
      () =>
        expect(page.getByRole('button', { name: 'Add a comment…' })).toBeVisible({
          timeout: 3_000,
        }),
    );

    // ── Watchers: opening the popover issues a single bounded roster read.
    await watchButton(page).click();
    await expect(watchersPopover(page)).toBeVisible();
    await expect(watchersPopover(page).getByText(/Watchers · \d+/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(watchersPopover(page)).toBeHidden();

    // ── Interaction smoke: posting on the loaded issue completes (a load-all
    // regression would stall the heavy page here). Open the composer with the
    // finding-#89 retry (click only while the rest-state button is still shown).
    const smokeText = 'At-scale smoke comment on the loaded issue.';
    await actUntil(
      async () => {
        const rest = page.getByRole('button', { name: 'Add a comment…' });
        if (await rest.isVisible()) await rest.click();
      },
      () => expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 3_000 }),
    );
    await page.locator('.ProseMirror').click();
    await page.keyboard.type(smokeText);
    // Submit, retried: re-click only while the Comment button is still shown
    // (a landed post collapses the composer), so a swallowed click is retried
    // and a landed one is never doubled.
    const submit = page.getByRole('button', { name: 'Comment', exact: true });
    await expect(async () => {
      if (await submit.isVisible()) await submit.click();
      await expect(threadList(page).getByText(smokeText)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Add a comment…' })).toBeVisible();

    // ── The whole-page census: every collection that was read paged within its
    // bound, and the genuinely-large ones (guarded > page size) actually issued
    // at least one client read whose width never reached the full set.
    for (const key of Object.keys(COLLECTIONS) as CollectionKey[]) expectBounded(census, key);
    expect(census.comments.length, 'the Show-more comments read fired').toBeGreaterThan(0);
    expect(census.attachments.length, 'the Show-more attachments read fired').toBeGreaterThan(0);
    expect(census.history.length, 'the History tab read fired').toBeGreaterThan(0);
    expect(census.all.length, 'the All tab read fired').toBeGreaterThan(0);
    expect(census.watchers.length, 'the watchers popover read fired').toBeGreaterThan(0);

    // No response anywhere carried the full collection (the load-all sentinel):
    // the widest read on each large source stayed under its true total.
    const widestComments = Math.max(...census.comments);
    expect(widestComments, 'no comments read returned the full thread set').toBeLessThan(
      fixture.counts.comments,
    );
    const totalAttachments = fixture.counts.panelAttachments + fixture.counts.editorAttachments;
    const widestAttachments = Math.max(...census.attachments);
    expect(widestAttachments, 'no attachments read returned the full set').toBeLessThan(
      totalAttachments,
    );
  });
});

test.describe('collab-at-scale — combined-page a11y (5.6.3)', () => {
  // WCAG 2.1 A + AA, the strict sweep config the per-story sweeps use (the 2.4.6
  // lineage; findings #35/#57). The combined page is the one state no per-story
  // sweep renders.
  const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

  interface AxeViolation {
    id: string;
    impact?: string | null;
    help: string;
    helpUrl: string;
    nodes: Array<{ target: unknown }>;
  }

  function formatViolations(surface: string, violations: AxeViolation[]): string {
    const lines = violations.map((v) => {
      const selectors = v.nodes.map((n) => `      - ${JSON.stringify(n.target)}`).join('\n');
      return `  [${v.impact ?? 'n/a'}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${selectors}`;
    });
    return `axe found ${violations.length} violation(s) on ${surface}:\n${lines.join('\n')}`;
  }

  /**
   * Pin the colour pattern deterministically (the default is `system`, which
   * resolves off prefers-color-scheme). The 1.0.5 ThemeProvider reads
   * `motir.theme.pattern` from localStorage on first render and writes
   * `data-theme` to <html>, so seeding the key + reloading flips the whole app.
   */
  async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
    await page.evaluate(
      (value) => window.localStorage.setItem('motir.theme.pattern', value),
      theme,
    );
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('heading', { name: SEED_COLLAB_LOADED_TITLE, level: 1 }),
    ).toBeVisible();
  }

  test('the loaded detail page — every Epic-5 surface at once — passes the strict sweep in light AND dark', async ({
    page,
  }) => {
    await gotoLoadedIssue(page);
    // The combined state: comments thread + attachments panel + full rail
    // (custom fields, labels, components) + watch control + activity are all
    // mounted on this one render.
    await expect(fileList(page).getByRole('listitem').first()).toBeVisible();
    await expect(page.getByText('Gateway reference')).toBeVisible();
    await expect(watchButton(page)).toBeVisible();

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(
        results.violations,
        formatViolations(`loaded issue detail (${theme})`, results.violations as AxeViolation[]),
      ).toEqual([]);
    }
  });
});
