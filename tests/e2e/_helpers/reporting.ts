/**
 * E2E + integration helpers for the reporting-shaped fixture (Subtask 6.7.1) —
 * the accessors the Story 6.7 at-scale specs (6.7.3) assert against.
 *
 * The fixture itself is seeded by `pnpm db:seed:reporting` — ALWAYS through
 * `runReportingSeed()` (a child process), never by importing and calling
 * `seedReportingFixture()` from the Playwright/Vitest runner: the runner process
 * has no Inngest dev server, so a service-layer work-item write here would fire a
 * post-commit job event with no event key. The runner script
 * (`scripts/seed-reporting.ts`) stubs that seam itself, so the child process
 * works in CI and locally with zero setup.
 *
 * Counts: the specs assert against `reportingSeedSizes()` — the SAME env-driven
 * resolver the seed used — so a reduced CI lane (lower SEED_REPORTING_* env on
 * both the seed step and the spec lane) keeps every assertion consistent.
 * `getReportingFixture()` reports the ACTUAL DB counts for census-style asserts.
 *
 * Expected aggregates: `expectedCreatedVsResolved()` and
 * `expectedStatusDistribution()` recompute the report values INDEPENDENTLY of the
 * 6.3 reporting service — in JS, over the rows read back from the DB, using the
 * SAME pure bucket math (`lib/reports/buckets`) the report's SQL `date_trunc`
 * mirrors. The 6.7.3 specs compare the report's SQL-aggregated output against
 * these, so a drift between the JS axis and the SQL grouping (or a regression in
 * the aggregate read) fails the suite.
 *
 * ⚠️ EVERY DIRECT READ IN THIS FILE IS `adminDb`, THE OWNER (MOTIR-2952). Class:
 * MOTIR-2881's class 2 — an ASSERTION doing direct DB work, never the subject of
 * the test. What it needs OWNERSHIP for is the word "INDEPENDENTLY" three
 * paragraphs up: this recompute is the ORACLE the report's SQL aggregate is
 * checked against, and an oracle that shares the admission mechanism it is
 * checking cannot detect that mechanism hiding rows. On the `@/lib/db` singleton
 * these reads bind no `app.workspace_id`, so under `motir_app` they answered `{}`
 * against a bound aggregate's real numbers — which is how the two epic6-at-scale
 * cases went red. Binding them instead of owning them would have made both series
 * pass through the same gate, and a policy that hid the whole corpus would then
 * read as `{} === {}`: green, and meaningless.
 *
 * (`currentWorkerAdminUrl()` answers the bare `DATABASE_URL` outside a Vitest
 * worker, so this is the same connection Playwright already had here.)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adminDb } from '@/tests/helpers/adminDb';
import { bucketAxis, bucketKey, reportWindow, type ReportPeriod } from '@/lib/reports/buckets';
import {
  resolveReportingSeedSizes,
  SEED_REPORTING_DASHBOARD_NAME,
  SEED_REPORTING_OWNER_EMAIL,
  SEED_REPORTING_PASSWORD,
  SEED_REPORTING_PROJECT_IDENTIFIER,
  SEED_REPORTING_PROJECT_NAME,
  SEED_REPORTING_WORKSPACE_NAME,
  type ReportingSeedSizes,
} from '@/scripts/seedReportingFixture';

const execFileAsync = promisify(execFile);

export {
  SEED_REPORTING_DASHBOARD_NAME,
  SEED_REPORTING_OWNER_EMAIL,
  SEED_REPORTING_PASSWORD,
  SEED_REPORTING_PROJECT_IDENTIFIER,
  SEED_REPORTING_PROJECT_NAME,
  SEED_REPORTING_WORKSPACE_NAME,
};
export type { ReportingSeedSizes };

/** The env-driven size knobs — the seed and the specs read the same numbers. */
export function reportingSeedSizes(): ReportingSeedSizes {
  return resolveReportingSeedSizes();
}

/**
 * Run the reporting seed as a child process (idempotent — clears and reseeds its
 * own workspace only). Pass `env` to lower the SEED_REPORTING_* knobs for a
 * reduced lane; everything else inherits the runner shell.
 */
export async function runReportingSeed(env: Record<string, string> = {}): Promise<void> {
  await execFileAsync('pnpm', ['db:seed:reporting'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    timeout: 30 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export interface ReportingFixture {
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  owner: { id: string; email: string };
  /** Actual DB counts over the corpus — the census denominators. */
  counts: {
    items: number;
    resolvedItems: number;
    customFieldValues: number;
    labelLinks: number;
    componentLinks: number;
    savedFilters: number;
    dashboards: number;
    dashboardWidgets: number;
    rules: number;
    enabledRules: number;
  };
}

/**
 * Resolve the seeded fixture from the DB (run `runReportingSeed()` first). Finds
 * the tenant by its fixed owner email + workspace name, then reports the actual
 * collection counts the bounded-read census asserts against.
 */
export async function getReportingFixture(): Promise<ReportingFixture> {
  const owner = await adminDb.user.findUniqueOrThrow({
    where: { email: SEED_REPORTING_OWNER_EMAIL },
  });
  const workspace = await adminDb.workspace.findFirstOrThrow({
    where: { name: SEED_REPORTING_WORKSPACE_NAME, memberships: { some: { userId: owner.id } } },
  });
  const project = await adminDb.project.findFirstOrThrow({
    where: { workspaceId: workspace.id, identifier: SEED_REPORTING_PROJECT_IDENTIFIER },
  });
  const doneKeys = await doneCategoryStatusKeys(project.id, workspace.id);

  const [
    items,
    resolvedItems,
    customFieldValues,
    labelLinks,
    componentLinks,
    savedFilters,
    dashboards,
    dashboardWidgets,
    rules,
    enabledRules,
  ] = await Promise.all([
    adminDb.workItem.count({ where: { projectId: project.id } }),
    adminDb.workItem.count({ where: { projectId: project.id, status: { in: doneKeys } } }),
    adminDb.customFieldValue.count({ where: { workItem: { projectId: project.id } } }),
    adminDb.workItemLabel.count({ where: { workItem: { projectId: project.id } } }),
    adminDb.workItemComponent.count({ where: { workItem: { projectId: project.id } } }),
    adminDb.savedFilter.count({ where: { projectId: project.id } }),
    adminDb.dashboard.count({ where: { workspaceId: workspace.id } }),
    adminDb.dashboardWidget.count({ where: { dashboard: { workspaceId: workspace.id } } }),
    adminDb.automationRule.count({ where: { projectId: project.id } }),
    adminDb.automationRule.count({ where: { projectId: project.id, enabled: true } }),
  ]);

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
    owner: { id: owner.id, email: owner.email },
    counts: {
      items,
      resolvedItems,
      customFieldValues,
      labelLinks,
      componentLinks,
      savedFilters,
      dashboards,
      dashboardWidgets,
      rules,
      enabledRules,
    },
  };
}

/** The project's `done`-category status keys (the "resolved" set — done +
 * cancelled in the default workflow). */
export async function doneCategoryStatusKeys(
  projectId: string,
  workspaceId: string,
): Promise<string[]> {
  const rows = await adminDb.workflowStatus.findMany({
    where: { projectId, workspaceId, category: 'done' },
    select: { key: true },
  });
  return rows.map((r) => r.key);
}

export interface ExpectedCreatedVsResolved {
  period: ReportPeriod;
  daysBack: number;
  windowStart: Date;
  windowEnd: Date;
  /** The full bucket-key axis (no holes), matching the report's. */
  axis: string[];
  /** bucketKey → count of items created in that bucket (within the window). */
  created: Record<string, number>;
  /** bucketKey → NET resolutions in that bucket (into-done `+1`, out-of-done
   * `-1`) — so a bucket carrying only a reopen is negative, exactly like the
   * report's series. */
  resolved: Record<string, number>;
}

/**
 * Recompute the created-vs-resolved series INDEPENDENTLY of `reportsService` —
 * in JS, over the back-dated rows, with the same pure bucket math the report's
 * SQL `date_trunc` reproduces. `created` buckets `work_item.createdAt`;
 * `resolved` buckets each status-transition REVISION by its own `changedAt`,
 * `+1` for a transition INTO a `done`-category status and `-1` for one out of
 * it — the same predicate `aggregateNetResolvedByBucket` applies. Only
 * in-window events count (the report's `[start, end]` rule).
 *
 * ⚠️ INDEPENDENT MEANS "COMPUTED SEPARATELY", NOT "COMPUTED DIFFERENTLY"
 * (MOTIR-3843). This oracle used to bucket `_max(changedAt)` over ALL of a
 * currently-`done` item's revisions — i.e. WHEN THE ITEM WAS LAST TOUCHED,
 * which is a different quantity from WHEN IT WAS RESOLVED. The two agree only
 * while a resolved item is never revised again; the moment one is (any field,
 * any revision), the oracle silently re-buckets it into the week of the EDIT
 * while the report keeps it at its resolution. That drift conserves the total
 * (+1 +1 −2 = 0 in the failure that found it), so it reads as a re-bucketing
 * rather than a miscount — and because `expected` is the side a reader trusts,
 * it accuses the shipped report. The at-scale seed happens to order the
 * done-transition LAST today, which is what made the old form pass; that is an
 * accident of the fixture, not a property of the quantity, and the oracle must
 * not depend on it.
 *
 * THE REOPEN ARM IS MODELLED, deliberately. The report's series subtracts on a
 * transition OUT of a done-category status, so an oracle that only added would
 * drift again the first time the fixture reopens a resolved item — the same
 * class of silent divergence, one arm over.
 */
export async function expectedCreatedVsResolved(
  projectId: string,
  workspaceId: string,
  opts: { now: Date; period?: ReportPeriod; daysBack: number },
): Promise<ExpectedCreatedVsResolved> {
  const period: ReportPeriod = opts.period ?? 'week';
  const { start, end } = reportWindow(opts.now, opts.daysBack);
  const axis = bucketAxis(period, start, end);

  const inWindow = (d: Date) => d.getTime() >= start.getTime() && d.getTime() <= end.getTime();
  const created: Record<string, number> = {};
  const resolved: Record<string, number> = {};
  for (const k of axis) {
    created[k] = 0;
    resolved[k] = 0;
  }

  const items = await adminDb.workItem.findMany({
    where: { projectId },
    select: { createdAt: true },
  });
  for (const it of items) {
    if (inWindow(it.createdAt)) created[bucketKey(period, it.createdAt)]! += 1;
  }

  // The resolved series: every in-window status-transition revision, netted by
  // the CATEGORY of the status it moved from and to — `aggregateNetResolvedByBucket`'s
  // predicate, expressed in JS over the rows rather than in SQL. The category
  // lookup mirrors that query's `workflow_status` joins on the diff's
  // `status.from` / `status.to` KEYS; an unresolvable key reads as "not done",
  // exactly like the SQL's LEFT-JOIN NULL. Archived items are excluded on the
  // same side the report excludes them.
  const categoryOf = new Map(
    (
      await adminDb.workflowStatus.findMany({
        where: { projectId, workspaceId },
        select: { key: true, category: true },
      })
    ).map((s) => [s.key, s.category]),
  );
  const revisions = await adminDb.workItemRevision.findMany({
    where: {
      workItem: { projectId, archivedAt: null },
      changeKind: 'updated',
      changedAt: { gte: start, lte: end },
    },
    select: { changedAt: true, diff: true },
  });
  for (const rev of revisions) {
    const diff = rev.diff as { status?: { from?: string | null; to?: string | null } } | null;
    const step = diff?.status;
    if (!step) continue; // not a status transition — the report ignores it, so do we
    const from = step.from == null ? undefined : categoryOf.get(step.from);
    const to = step.to == null ? undefined : categoryOf.get(step.to);
    const delta = to === 'done' ? (from === 'done' ? 0 : 1) : from === 'done' ? -1 : 0;
    if (delta !== 0) resolved[bucketKey(period, rev.changedAt)]! += delta;
  }

  return {
    period,
    daysBack: opts.daysBack,
    windowStart: start,
    windowEnd: end,
    axis,
    created,
    resolved,
  };
}

/**
 * Recompute the status distribution INDEPENDENTLY of `reportsService` — group
 * the corpus by current `status`, count-descending, the shape the donut widget
 * renders. (Matches the report's group-by-status aggregate.)
 */
export async function expectedStatusDistribution(
  projectId: string,
): Promise<Array<{ status: string; count: number }>> {
  const grouped = await adminDb.workItem.groupBy({
    by: ['status'],
    where: { projectId },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ status: g.status, count: g._count._all }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}
