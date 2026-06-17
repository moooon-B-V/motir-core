// E2E: search / reporting / automation AT SCALE (Story 6.7 · Subtask 6.7.3) —
// the finding-#57 sentinel for Epic 6, over the reporting-shaped corpus the
// 6.7.1 fixture builds (`pnpm db:seed:reporting`). Selected by the
// `epic6-at-scale` grep (the verification recipe runs
// `pnpm test:e2e --grep epic6-at-scale`); it is EXCLUDED from the default /
// bulk `pnpm test:e2e` run (the heavy corpus seed is slow — the bulk legs
// `--grep-invert "(board(-scrum)?|collab|epic6)-at-scale|@a11y"` it out) and
// gets its OWN reduced-cap CI step, exactly like board-at-scale / collab-at-scale.
//
// The corpus is cap-parameterised by the SEED_REPORTING_* envs (the
// board/collab-at-scale precedent): the CI lane lowers SEED_REPORTING_ITEMS so
// the run stays inside the webServer window while still EXCEEDING the report /
// list page sizes (so paging vs. load-all stays distinguishable); locally it
// runs at the full 10k default. Both the seed child process AND this spec read
// the same env, so every count/aggregate assertion stays consistent across lanes.
//
// Three deliverables (the 6.7.3 card):
//   1. INDEXED SEARCH — the saved-filter-backed widget read pages over the
//      corpus (bounded items + a true total; no full-set response). The
//      index-usage EXPLAIN spot-checks are the Vitest companion's half
//      (tests/integration/epic6-at-scale.test.ts) — deterministic with the
//      planner forced off Seq Scan, which a network E2E can't do.
//   2. SQL-AGGREGATED REPORTING — the created-vs-resolved + status-distribution
//      widget reads return aggregated buckets/segments (NEVER the row set —
//      the census), and the numbers equal the 6.7.1 helpers' independently
//      recomputed expectations (correctness, not just boundedness).
//   3. THE COMBINED A11Y SWEEP — every Epic-6 admin surface at once over the
//      corpus project (members, workflow, fields, components, automation) AND a
//      populated dashboard pass the strict WCAG sweep in light AND dark — the
//      combined state no per-story sweep renders.
//
// The corpus is seeded ALWAYS through `runReportingSeed()` (a child process —
// the runner stubs the Inngest seam itself; see tests/e2e/_helpers/reporting.ts).

import { expect, test, type Page, type Response } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { db } from '@/lib/db';
import { signIn } from './_helpers/shell-session';
import { WCAG_TAGS, formatViolations, type AxeViolation } from './_helpers/a11y';
import {
  runReportingSeed,
  getReportingFixture,
  reportingSeedSizes,
  expectedCreatedVsResolved,
  expectedStatusDistribution,
  SEED_REPORTING_DASHBOARD_NAME,
  SEED_REPORTING_OWNER_EMAIL,
  SEED_REPORTING_PASSWORD,
  type ReportingFixture,
} from './_helpers/reporting';

let fixture: ReportingFixture;
let dashboardId: string;

test.describe('epic6-at-scale (6.7.3) — search / reporting / automation over the corpus', () => {
  test.beforeAll(async () => {
    test.setTimeout(30 * 60_000); // the full-size corpus seed dominates locally
    await runReportingSeed();
    fixture = await getReportingFixture();

    // The census is only meaningful when the corpus EXCEEDS the report/list page
    // sizes — otherwise one bounded read returns the whole set and "paged" vs.
    // "load-all" are indistinguishable. Fail loud (collab-at-scale's guard) when
    // a lane lowered the cap too far.
    const sizes = reportingSeedSizes();
    if (fixture.counts.items <= 50) {
      throw new Error(
        `epic6-at-scale: the corpus (${fixture.counts.items} items) must EXCEED the ` +
          `50-row list page size so paging engages. Raise SEED_REPORTING_ITEMS for this lane ` +
          `(configured sizes: ${JSON.stringify(sizes)}).`,
      );
    }
    if (fixture.counts.dashboardWidgets === 0 || fixture.counts.enabledRules === 0) {
      throw new Error(
        `epic6-at-scale: the corpus must carry a populated dashboard + enabled rules ` +
          `(got widgets=${fixture.counts.dashboardWidgets}, rules=${fixture.counts.enabledRules}).`,
      );
    }

    const dashboard = await db.dashboard.findFirstOrThrow({
      where: { workspaceId: fixture.workspaceId, name: SEED_REPORTING_DASHBOARD_NAME },
    });
    dashboardId = dashboard.id;
  });

  // ── A census of the reporting/search reads: every collected response's row
  //    array stays bounded; the report reads carry aggregates, not rows. ──────
  interface ReportPayload {
    url: string;
    body: Record<string, unknown>;
  }
  interface ReportCensus {
    payloads: ReportPayload[];
    /** Await every in-flight body parse — call after the page has settled so the
     * census is complete (no reliance on microtask timing). */
    settle: () => Promise<void>;
  }
  function installReportCensus(page: Page): ReportCensus {
    const payloads: ReportPayload[] = [];
    const pending: Promise<void>[] = [];
    page.on('response', (res: Response) => {
      if (res.request().method() !== 'GET') return;
      const url = res.url();
      if (!/\/api\/reports\/(created-vs-resolved|distribution|filter-results)/.test(url)) return;
      pending.push(
        res
          .json()
          .then((body: Record<string, unknown>) => {
            payloads.push({ url, body });
          })
          .catch(() => {
            // Non-JSON / aborted — not a widget read; ignore.
          }),
      );
    });
    return { payloads, settle: async () => void (await Promise.all(pending)) };
  }

  /** Open the populated "Delivery analytics" dashboard and wait for every
   * widget read to settle. */
  async function openDashboard(page: Page, census?: ReportCensus): Promise<void> {
    await signIn(page, SEED_REPORTING_OWNER_EMAIL, SEED_REPORTING_PASSWORD);
    // Arm an AUTHORITATIVE wait for the widgets' reads BEFORE navigating (the
    // caller arms the census listener BEFORE this runs, too). Each widget body
    // fetches from a client `useEffect` — i.e. only AFTER hydration — so
    // `networkidle` alone races the reads: it can resolve in the window between
    // the load event and the post-hydration fetch (a hydration-failed re-render
    // that "regenerates the tree on the client" widens that window), draining a
    // census that is still empty → the `payloads.length > 0` flake (MOTIR-1005).
    // We wait on the reads themselves + the rendered "no longer loading" state,
    // never the idle heuristic (the repo's E2E authoritative-wait rule).
    const firstWidgetRead = page.waitForResponse(
      (res) =>
        res.request().method() === 'GET' &&
        /\/api\/reports\/(created-vs-resolved|distribution|filter-results)/.test(res.url()),
      { timeout: 30_000 },
    );
    await page.goto(`/dashboard/${dashboardId}`);
    await expect(page.getByRole('heading', { name: SEED_REPORTING_DASHBOARD_NAME })).toBeVisible({
      timeout: 30_000,
    });
    // A widget read has landed → every widget card has mounted and fired its
    // fetch. Now wait until NO widget is still loading: each body renders a
    // `role="status"` ("Loading widget…") skeleton until its read resolves or
    // errors, and that role appears nowhere else on the dashboard route — so
    // count 0 is the authoritative "all reads completed + rendered" signal.
    await firstWidgetRead;
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 30_000 });
    // Belt: settle the network, then drain the in-flight body-parse promises so
    // the census is complete (no reliance on microtask timing).
    await page.waitForLoadState('networkidle');
    if (census) await census.settle();
  }

  test('reporting widgets aggregate IN SQL and page their reads — the census carries no row set', async ({
    page,
  }) => {
    const census = installReportCensus(page);
    await openDashboard(page, census);
    const { payloads } = census;

    expect(payloads.length, 'the dashboard issued widget reads').toBeGreaterThan(0);

    for (const { url, body } of payloads) {
      // Every widget read is a 200-level result envelope; we only census the OK
      // ones (a stale/no-access widget carries no data to bound).
      const data = (body as { state?: string; data?: Record<string, unknown> }).data;
      if ((body as { state?: string }).state !== 'ok' || !data) continue;

      if (/created-vs-resolved/.test(url)) {
        // AGGREGATED: buckets, never the row set; bounded by the window cap.
        expect(Array.isArray(data.buckets), `created-vs-resolved is bucketed: ${url}`).toBe(true);
        expect((data.buckets as unknown[]).length).toBeLessThanOrEqual(120);
        expect(data.items, 'no row set on the created-vs-resolved read').toBeUndefined();
      } else if (/distribution/.test(url)) {
        // AGGREGATED: segments, never the row set; bounded by the value vocabulary.
        expect(Array.isArray(data.segments), `distribution is segmented: ${url}`).toBe(true);
        expect((data.segments as unknown[]).length).toBeLessThan(fixture.counts.items);
        expect(data.items, 'no row set on the distribution read').toBeUndefined();
      } else {
        // filter-results: PAGED — a bounded item page + the true total, never
        // the whole corpus (the indexed-search bounded-read proof at the wire).
        const items = data.items as unknown[];
        const pageSize = data.pageSize as number;
        expect(Array.isArray(items)).toBe(true);
        expect(items.length).toBeLessThanOrEqual(pageSize);
        expect(items.length, 'filter-results never returns the full corpus').toBeLessThan(
          fixture.counts.items,
        );
      }
    }
  });

  test('the report numbers equal the independently-recomputed expectations (6.7.1 helpers)', async ({
    page,
  }) => {
    const census = installReportCensus(page);
    await openDashboard(page, census);
    const { payloads } = census;

    // created-vs-resolved — compare bucket maps for the project-scoped widget.
    const cvr = payloads.find((p) => /created-vs-resolved/.test(p.url) && /projectId=/.test(p.url));
    if (cvr) {
      const data = (cvr.body as { data: Record<string, unknown> }).data;
      const params = new URL(cvr.url).searchParams;
      const period = (params.get('period') ?? 'week') as 'day' | 'week' | 'month';
      const daysBack = Number(params.get('daysBack') ?? '182');
      const expected = await expectedCreatedVsResolved(fixture.projectId, fixture.workspaceId, {
        now: new Date(),
        period,
        daysBack,
      });
      const createdGot: Record<string, number> = {};
      const resolvedGot: Record<string, number> = {};
      for (const b of data.buckets as Array<{ date: string; created: number; resolved: number }>) {
        createdGot[b.date] = b.created;
        resolvedGot[b.date] = b.resolved;
      }
      expect(createdGot).toEqual(expected.created);
      expect(resolvedGot).toEqual(expected.resolved);
    }

    // status distribution — compare a status→count map for the project-scoped
    // status widget (robust to count-tie ordering).
    const dist = payloads.find(
      (p) =>
        /distribution/.test(p.url) && /statistic=status/.test(p.url) && /projectId=/.test(p.url),
    );
    if (dist) {
      const data = (
        dist.body as { data: { segments: Array<{ id: string | null; count: number }> } }
      ).data;
      const got = Object.fromEntries(data.segments.map((s) => [s.id, s.count]));
      const expected = Object.fromEntries(
        (await expectedStatusDistribution(fixture.projectId)).map((r) => [r.status, r.count]),
      );
      expect(got).toEqual(expected);
    }

    // At least one of the two project-scoped reads must have been asserted —
    // otherwise the seed's widget scoping drifted and this test silently no-ops.
    expect(Boolean(cvr) || Boolean(dist), 'a project-scoped report widget was present').toBe(true);
  });

  // ── The combined a11y sweep: every Epic-6 admin surface over the corpus
  //    project + the populated dashboard, in light AND dark. ──────────────────

  /** Pin the colour pattern deterministically (the 1.0.5 ThemeProvider reads
   * `motir.theme.pattern` from localStorage on first render and writes
   * `data-theme` to <html>). */
  async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
    await page.evaluate((v) => window.localStorage.setItem('motir.theme.pattern', v), theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  }

  async function sweep(page: Page, label: string): Promise<void> {
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(
        results.violations,
        formatViolations(`${label} (${theme})`, results.violations as AxeViolation[]),
      ).toEqual([]);
    }
  }

  // The fully-populated Epic-6 admin surfaces over the corpus project, plus the
  // populated dashboard — landmark/heading uniqueness + focus order across these
  // stacked, data-heavy sections is exactly the bug class only the combined
  // state shows.
  const ADMIN_SURFACES: { label: string; path: string }[] = [
    { label: 'project members & roles', path: '/settings/project/members' },
    { label: 'workflow', path: '/settings/project/workflow' },
    { label: 'custom fields', path: '/settings/project/fields' },
    { label: 'components', path: '/settings/project/components' },
    { label: 'automation rules', path: '/settings/project/automation' },
  ];

  for (const surface of ADMIN_SURFACES) {
    test(`a11y — ${surface.label} over the corpus, light + dark`, async ({ page }) => {
      await signIn(page, SEED_REPORTING_OWNER_EMAIL, SEED_REPORTING_PASSWORD);
      await page.goto(surface.path);
      // The settings area chrome is the stable landmark to wait on before axe.
      await expect(page.getByRole('navigation', { name: 'Project settings' })).toBeVisible({
        timeout: 30_000,
      });
      await sweep(page, surface.label);
    });
  }

  test('a11y — the populated dashboard, light + dark', async ({ page }) => {
    await openDashboard(page);
    await sweep(page, 'populated dashboard');
  });
});
